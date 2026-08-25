import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { isBlockedIp } from "./ip-guard.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_REDIRECTS = 5;

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Injectable for tests — defaults to `node:dns`'s `lookup`. */
  lookupFn?: typeof dnsLookup;
  /**
   * Injectable for tests that need to exercise the HTTP mechanics (redirects,
   * timeout, size cap) against a real `127.0.0.1` test server without the
   * SSRF guard rejecting loopback — defaults to {@link isBlockedIp}. No
   * production caller overrides this; it's the same check either way, just
   * swappable so those tests don't have to make real internet requests.
   */
  ipGuardFn?: (ip: string) => boolean;
}

export interface SafeFetchResult {
  ok: boolean;
  status?: number;
  contentType?: string;
  body?: string;
  /** True when the response body was cut off at maxBytes. */
  truncated?: boolean;
  error?: string;
}

type DnsLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * `http.RequestOptions`/`https.RequestOptions` don't declare `autoSelectFamily`
 * in @types/node, even though Node's runtime forwards it straight through to
 * the underlying `net.connect()` call it makes (it's a `net.TcpNetConnectOpts`
 * field) — this augments the option bag's type to match actual runtime
 * behavior instead of reaching for `any`.
 */
type RequestOptionsWithFamily = (http.RequestOptions | https.RequestOptions) & {
  autoSelectFamily?: boolean;
};

/**
 * Wraps a `dns.lookup`-compatible function so every resolved address is
 * validated with {@link isBlockedIp} before Node ever opens a socket to it.
 *
 * This is the core SSRF defense: `http.request`/`https.request` call this
 * `lookup` function themselves, right before connecting, and dial whatever
 * IP it hands back — there's no separate "resolve, check, then connect by
 * hostname again" step for an attacker to race with a DNS response that
 * changes between the check and the connect (a "DNS rebinding" attack). A
 * hostname that resolves to a private/loopback/link-local IP is rejected
 * here even if the hostname itself looks perfectly public.
 *
 * Node's `autoSelectFamily` (Happy Eyeballs, on by default since Node 20)
 * calls `lookup` with `{ all: true }` and expects *every* matching record
 * back, then races connections across all of them, using whichever
 * completes first — so a single "is address[0] safe?" check here would
 * leave every other entry undialed-but-unvalidated. An attacker controlling
 * DNS for their own sourceUrl domain could return a fast public decoy
 * record first (passing an address[0]-only check) and a slow-to-connect
 * internal/metadata address second, then let Happy Eyeballs fall through to
 * the second once the first is made to lag or fail. `performRequest` also
 * sets `autoSelectFamily: false` so Node never actually requests `{all:
 * true}` in the first place — this per-entry filtering is belt-and-suspenders
 * in case that ever changes upstream (a Node default flip, an option this
 * function is reused with elsewhere, etc.), not the only layer relied on.
 */
export function guardedLookup(lookupFn: typeof dnsLookup, ipGuardFn: (ip: string) => boolean): typeof dnsLookup {
  const wrapped = (
    hostname: string,
    optionsOrCallback: unknown,
    maybeCallback?: DnsLookupCallback,
  ): void => {
    const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as DnsLookupCallback;
    const options = typeof optionsOrCallback === "function" ? {} : (optionsOrCallback as object);

    (lookupFn as (h: string, o: object, cb: DnsLookupCallback) => void)(hostname, options, (err, address, family) => {
      if (err) {
        callback(err, address, family);
        return;
      }

      if (Array.isArray(address)) {
        // `{ all: true }` shape (Happy Eyeballs et al.) — every entry must
        // be individually validated and only the safe ones passed on. Never
        // forward the array unfiltered: Node dials any entry it contains.
        const safe = address.filter((entry) => entry?.address && !ipGuardFn(entry.address));
        if (safe.length === 0) {
          callback(
            new Error(`blocked: "${hostname}" resolved to no public addresses`),
            address,
            family,
          );
          return;
        }
        callback(err, safe, family);
        return;
      }

      const resolved = address;
      if (!resolved || ipGuardFn(resolved)) {
        callback(
          new Error(`blocked: "${hostname}" resolved to a non-public address (${resolved ?? "unknown"})`),
          address,
          family,
        );
        return;
      }
      callback(err, address, family);
    });
  };
  return wrapped as typeof dnsLookup;
}

/**
 * Fetches `rawUrl` with SSRF hardening intended specifically for a
 * server-side fetch of a user-supplied URL (the source-URL snapshot
 * feature): only http/https, DNS-rebinding-safe private/loopback/link-local
 * IP blocking (checked on the resolved IP, not the hostname string — see
 * {@link isBlockedIp}), a request timeout, a response size cap, and manual
 * (re-validated-per-hop) redirect handling instead of auto-follow, so a
 * redirect can't be used to smuggle the request to a blocked address after
 * the initial URL passed validation.
 *
 * Never throws — every failure mode (blocked address, timeout, network
 * error, non-2xx, bad redirect) comes back as `{ ok: false, error }` so
 * callers can record "snapshot unavailable" without treating it as fatal.
 */
export async function fetchUrlSafely(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const lookupFn = opts.lookupFn ?? dnsLookup;
  const ipGuardFn = opts.ipGuardFn ?? isBlockedIp;

  let currentUrl: URL;
  try {
    currentUrl = new URL(rawUrl);
  } catch {
    return { ok: false, error: "invalid URL" };
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") {
      return { ok: false, error: `unsupported protocol: ${currentUrl.protocol}` };
    }

    // A literal IP host (e.g. "http://127.0.0.1/") never goes through
    // `lookup` at all — Node connects to it directly — so it needs its own
    // check up front rather than relying on guardedLookup.
    if (isIP(currentUrl.hostname) !== 0 && ipGuardFn(currentUrl.hostname)) {
      return { ok: false, error: `blocked: ${currentUrl.hostname} is not a public address` };
    }

    const hopResult = await performRequest(currentUrl, { timeoutMs, maxBytes, lookupFn, ipGuardFn });

    if ("redirectTo" in hopResult) {
      let nextUrl: URL;
      try {
        nextUrl = new URL(hopResult.redirectTo, currentUrl);
      } catch {
        return { ok: false, error: "invalid redirect target" };
      }
      currentUrl = nextUrl;
      continue;
    }
    return hopResult;
  }

  return { ok: false, error: "too many redirects" };
}

function performRequest(
  url: URL,
  opts: { timeoutMs: number; maxBytes: number; lookupFn: typeof dnsLookup; ipGuardFn: (ip: string) => boolean },
): Promise<SafeFetchResult | { redirectTo: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: SafeFetchResult | { redirectTo: string }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const lib = url.protocol === "https:" ? https : http;
    const requestOptions: RequestOptionsWithFamily = {
      method: "GET",
      lookup: guardedLookup(opts.lookupFn, opts.ipGuardFn),
      // Belt-and-suspenders alongside guardedLookup's per-entry filtering
      // above: without this, Node's Happy Eyeballs (on by default since
      // Node 20) calls `lookup` with `{ all: true }` and races connections
      // across every returned address, so this keeps it from requesting
      // `{ all: true }` at all — `lookup` is only ever called for a single
      // address per hop.
      autoSelectFamily: false,
      timeout: opts.timeoutMs,
      headers: {
        "User-Agent": "model-hub-source-snapshot/1.0 (+https://github.com/mirceanton/model-hub)",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    };
    const req = lib.request(
      url,
      requestOptions,
      (res) => {
        const status = res.statusCode ?? 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          finish({ redirectTo: res.headers.location });
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          finish({ ok: false, status, error: `unexpected status ${status}` });
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;

        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          received += chunk.length;
          if (received > opts.maxBytes) {
            const alreadyOver = received - chunk.length;
            const remaining = opts.maxBytes - alreadyOver;
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            truncated = true;
            // Stop reading further bytes off the wire immediately — the cap
            // is a defense against a hostile/huge response, not just a
            // storage-size nicety.
            req.destroy();
            finish({
              ok: true,
              status,
              contentType: res.headers["content-type"],
              body: Buffer.concat(chunks).toString("utf8"),
              truncated: true,
            });
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          finish({
            ok: true,
            status,
            contentType: res.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
            truncated: false,
          });
        });

        res.on("error", (err) => {
          finish({ ok: false, error: err.message });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => {
      finish({ ok: false, error: err.message });
    });
    req.end();
  });
}
