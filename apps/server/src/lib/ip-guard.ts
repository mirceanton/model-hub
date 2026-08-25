import ipaddr from "ipaddr.js";

/**
 * True when `ip` must never be dialed by the source-URL snapshot fetcher
 * (see lib/safe-fetch.ts) — loopback (127.0.0.1, ::1), RFC1918 private
 * ranges, link-local (169.254.0.0/16, which is where cloud metadata
 * endpoints like 169.254.169.254 live), multicast, and every other
 * non-globally-routable range, for both IPv4 and IPv6.
 *
 * This is an allow-list, not a deny-list: `ipaddr.js` classifies an address
 * into a named range (private/loopback/linkLocal/multicast/reserved/
 * uniqueLocal/...) and falls back to "unicast" only when nothing else
 * matches, so a range we forgot to enumerate fails closed (blocked) instead
 * of failing open. `ipaddr.process` additionally collapses an IPv4-mapped
 * IPv6 address (e.g. "::ffff:127.0.0.1") down to its embedded IPv4 form
 * before classification, so that particular disguise doesn't slip through.
 */
export function isBlockedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip);
  } catch {
    // Unparsable input is never something we should connect to.
    return true;
  }
  return addr.range() !== "unicast";
}
