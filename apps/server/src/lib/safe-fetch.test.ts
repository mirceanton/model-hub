import type { LookupAddress } from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { isBlockedIp } from "./ip-guard.js";
import { fetchUrlSafely, guardedLookup, type SafeFetchOptions } from "./safe-fetch.js";

/** Always classifies every address as safe — lets tests exercise real HTTP mechanics against a 127.0.0.1 test server without the SSRF guard rejecting loopback (see SafeFetchOptions.ipGuardFn's doc comment). */
const allowAllIps = () => false;

let server: Server | null = null;

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("expected a bound TCP address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe("fetchUrlSafely — SSRF blocking", () => {
  it("rejects a loopback literal IP without making a request", async () => {
    const result = await fetchUrlSafely("http://127.0.0.1:1/anything");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a public address/);
  });

  it("rejects the cloud metadata link-local address", async () => {
    const result = await fetchUrlSafely("http://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a public address/);
  });

  it("rejects a private RFC1918 address", async () => {
    const result = await fetchUrlSafely("http://10.0.0.5/");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a public address/);
  });

  it("rejects a non-http(s) protocol", async () => {
    const result = await fetchUrlSafely("file:///etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unsupported protocol/);
  });

  it("blocks a hostname whose DNS resolution is a private/loopback IP — the resolved IP is what's checked, not the hostname string", async () => {
    // Simulates DNS rebinding: a hostname that looks arbitrary/public
    // resolves (at connect time) to a metadata/loopback address. The default
    // ipGuardFn (isBlockedIp) is left in place here — only lookupFn is
    // faked — so this proves the resolved-IP check actually runs.
    const fakeLookup = ((_hostname: string, _opts: unknown, cb: unknown) => {
      (cb as (err: null, address: string, family: number) => void)(null, "169.254.169.254", 4);
    }) as SafeFetchOptions["lookupFn"];

    const result = await fetchUrlSafely("http://looks-totally-public.example.com/", {
      lookupFn: fakeLookup,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/resolved to a non-public address/);
  });

  it("re-validates a redirect target, not just the initial URL", async () => {
    // A guard that allows the loopback test server (hop 1) but blocks one
    // specific marker address (hop 2, the redirect target) — proves each
    // hop is checked on its own, not just the URL the caller started with.
    const blockOnlyMarkerIp = (ip: string) => ip === "169.254.169.254";

    const base = await listen((_req, res) => {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });

    const result = await fetchUrlSafely(base, { ipGuardFn: blockOnlyMarkerIp });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a public address/);
  });
});

// Regression coverage for a real, PoC-confirmed bypass: guardedLookup used to
// validate only address[0] of an `{ all: true }`-shaped (Happy Eyeballs)
// array response, then pass the *entire unfiltered array* on to Node — which
// dials whichever entry connects first. An attacker controlling DNS for
// their own sourceUrl domain could return a fast public decoy record first
// (passing the address[0]-only check) and an internal/metadata address
// second, then force Node onto the unvalidated second entry by making the
// first slow or unavailable. The fix is two-layered: (1) guardedLookup now
// filters *every* entry in an array response, and (2) performRequest sets
// `autoSelectFamily: false` so Node never requests `{ all: true }` in the
// first place. These tests target layer (1) directly — with the real,
// unweakened isBlockedIp guard — since layer (2) alone (verified by probing
// Node directly) already makes an array response fail outright with
// ERR_INVALID_IP_ADDRESS, which would mask a regression in layer (1) if it
// were the only thing asserted on.
describe("guardedLookup — array ({ all: true }) DNS responses", () => {
  function callGuardedLookup(
    entries: LookupAddress[],
  ): Promise<{ err: NodeJS.ErrnoException | null; address: string | LookupAddress[] }> {
    const fakeUnderlyingLookup = ((_hostname: string, _options: unknown, cb: unknown) => {
      (cb as (err: null, address: LookupAddress[], family: undefined) => void)(null, entries, undefined);
    }) as SafeFetchOptions["lookupFn"];

    // The real default guard (isBlockedIp), not a test-weakened one — this
    // is exactly what production code wires up.
    const wrapped = guardedLookup(fakeUnderlyingLookup!, isBlockedIp);

    return new Promise((resolve) => {
      wrapped("attacker-controlled.example", { all: true }, (err, address) => {
        resolve({ err, address });
      });
    });
  }

  it("filters out a private/loopback entry even when a public decoy sorts first (the exact bypass shape)", async () => {
    const result = await callGuardedLookup([
      { address: "8.8.8.8", family: 4 }, // public decoy, sorts first
      { address: "127.0.0.1", family: 4 }, // the actual attack target
    ]);

    expect(result.err).toBeNull();
    expect(result.address).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("filters out a cloud-metadata entry regardless of its position in the array", async () => {
    const result = await callGuardedLookup([
      { address: "1.1.1.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
      { address: "9.9.9.9", family: 4 },
    ]);

    expect(result.err).toBeNull();
    expect(result.address).toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "9.9.9.9", family: 4 },
    ]);
  });

  it("errors (passes nothing to Node) when every entry is unsafe", async () => {
    const result = await callGuardedLookup([
      { address: "127.0.0.1", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ]);

    expect(result.err).toBeInstanceOf(Error);
  });
});

describe("fetchUrlSafely — array DNS response end-to-end, real isBlockedIp guard", () => {
  it("never dials the loopback entry of an { all: true }-shaped response, even with a public decoy first", async () => {
    let hitCount = 0;
    const base = await listen((_req, res) => {
      hitCount += 1;
      res.end("should never be reached");
    });
    const loopbackPort = new URL(base).port;

    // Mimics a hostile/non-standard lookup implementation that always
    // returns Happy-Eyeballs-shaped ({ all: true }) results regardless of
    // what it was asked for — public decoy first, the real local test
    // server (standing in for a private/internal target) second.
    const fakeLookup = ((_hostname: string, _options: unknown, cb: unknown) => {
      (cb as (err: null, address: LookupAddress[], family: undefined) => void)(
        null,
        [
          { address: "8.8.8.8", family: 4 }, // genuinely public ("unicast"), not reserved/test-net
          { address: "127.0.0.1", family: 4 },
        ],
        undefined,
      );
    }) as SafeFetchOptions["lookupFn"];

    const result = await fetchUrlSafely(`http://attacker-controlled.example:${loopbackPort}/`, {
      lookupFn: fakeLookup,
      // Real default ipGuardFn (isBlockedIp) — deliberately not overridden,
      // unlike the HTTP-mechanics tests above.
      timeoutMs: 1000,
    });

    expect(hitCount).toBe(0);
    expect(result.ok).toBe(false);
  });
});

describe("fetchUrlSafely — HTTP mechanics (SSRF guard disabled via test-only ipGuardFn)", () => {
  it("fetches a small response successfully", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>hello</body></html>");
    });

    const result = await fetchUrlSafely(base, { ipGuardFn: allowAllIps });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toBe("<html><body>hello</body></html>");
    expect(result.truncated).toBe(false);
  });

  it("follows a redirect to its target", async () => {
    const target = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("redirected content");
    });
    // A second server that redirects to the first.
    const redirector = await listen((_req, res) => {
      res.writeHead(302, { Location: target });
      res.end();
    });

    const result = await fetchUrlSafely(redirector, { ipGuardFn: allowAllIps });
    expect(result.ok).toBe(true);
    expect(result.body).toBe("redirected content");
  });

  it("reports a non-2xx status as a failure", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(404);
      res.end("not found");
    });

    const result = await fetchUrlSafely(base, { ipGuardFn: allowAllIps });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });

  it("caps an oversized response instead of buffering it all", async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      // Write far more than the tiny maxBytes cap below.
      const chunk = "x".repeat(1024);
      let written = 0;
      const interval = setInterval(() => {
        if (written >= 20 * 1024 || res.destroyed) {
          clearInterval(interval);
          if (!res.destroyed) res.end();
          return;
        }
        written += chunk.length;
        res.write(chunk);
      }, 1);
    });

    const result = await fetchUrlSafely(base, { ipGuardFn: allowAllIps, maxBytes: 2048 });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.body!.length).toBeLessThanOrEqual(2048);
  });

  it("times out a server that never responds", async () => {
    const base = await listen((_req, _res) => {
      // Never call res.end() — simulates a hung/slow origin.
    });

    const result = await fetchUrlSafely(base, { ipGuardFn: allowAllIps, timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  }, 5000);
});
