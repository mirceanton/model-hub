import { describe, expect, it } from "vitest";
import { isBlockedIp } from "./ip-guard.js";

describe("isBlockedIp", () => {
  it("blocks loopback addresses", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.1.2.3")).toBe(true);
    expect(isBlockedIp("::1")).toBe(true);
  });

  it("blocks the cloud metadata link-local address", () => {
    expect(isBlockedIp("169.254.169.254")).toBe(true);
  });

  it("blocks RFC1918 private ranges", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("172.16.5.4")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
  });

  it("blocks IPv6 unique-local and link-local ranges", () => {
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456:789a::1")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
  });

  it("blocks an IPv4-mapped IPv6 disguise of a private address", () => {
    // DNS rebinding / disguise attempt: looks like an IPv6 literal, but
    // ipaddr.process() collapses it to the embedded IPv4 first.
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:10.0.0.5")).toBe(true);
  });

  it("blocks unspecified, multicast, and reserved ranges", () => {
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("224.0.0.1")).toBe(true);
    expect(isBlockedIp("240.0.0.1")).toBe(true);
    expect(isBlockedIp("::")).toBe(true);
    expect(isBlockedIp("ff02::1")).toBe(true);
  });

  it("blocks unparsable input", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });

  it("allows public unicast addresses", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });
});
