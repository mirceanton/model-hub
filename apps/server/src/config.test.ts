import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BASE_ENV = {
  LIBRARY_ROOT: "/library",
  DATABASE_PATH: "/data/model-hub.sqlite3",
};

describe("loadConfig", () => {
  it("applies defaults for optional settings", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.port).toBe(4000);
    expect(config.libraryScanIntervalMs).toBe(60_000);
    expect(config.syncDebounceMs).toBe(5_000);
    expect(config.libraryWatchEnabled).toBe(true);
    expect(config.libraryWatchUsePolling).toBe(false);
    expect(config.logLevel).toBe("info");
    expect(config.thumbnailConcurrency).toBe(1);
    expect(config.staticWebDir).toBeNull();
  });

  it("honors STATIC_WEB_DIR when set", () => {
    const config = loadConfig({ ...BASE_ENV, STATIC_WEB_DIR: "/app/web/dist" });
    expect(config.staticWebDir).toBe("/app/web/dist");
  });

  it("coerces and honors overrides", () => {
    const config = loadConfig({
      ...BASE_ENV,
      PORT: "5050",
      LIBRARY_WATCH_USE_POLLING: "true",
      LOG_LEVEL: "debug",
      THUMBNAIL_CONCURRENCY: "3",
    });
    expect(config.port).toBe(5050);
    expect(config.libraryWatchUsePolling).toBe(true);
    expect(config.logLevel).toBe("debug");
    expect(config.thumbnailConcurrency).toBe(3);
  });

  it("defaults webBaseUrl to its own origin, derived from PORT", () => {
    const config = loadConfig({ ...BASE_ENV, PORT: "5050" });
    expect(config.webBaseUrl).toBe("http://127.0.0.1:5050");
  });

  it("honors an explicit WEB_BASE_URL override", () => {
    const config = loadConfig({ ...BASE_ENV, WEB_BASE_URL: "http://localhost:5173" });
    expect(config.webBaseUrl).toBe("http://localhost:5173");
  });

  it("fails fast with a clear error when LIBRARY_ROOT is missing", () => {
    expect(() => loadConfig({ DATABASE_PATH: "/data/model-hub.sqlite3" })).toThrow(
      /LIBRARY_ROOT/,
    );
  });

  it("fails fast with a clear error when DATABASE_PATH is missing", () => {
    expect(() => loadConfig({ LIBRARY_ROOT: "/library" })).toThrow(/DATABASE_PATH/);
  });

  it("defaults to single-user mode (oidc: null) when no OIDC_* vars are set", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.oidc).toBeNull();
  });

  const SESSION_SECRET = "x".repeat(32);

  it("enables OIDC when all three required vars plus SESSION_SECRET are set", () => {
    const config = loadConfig({
      ...BASE_ENV,
      OIDC_ISSUER_URL: "https://auth.example.com",
      OIDC_CLIENT_ID: "model-hub",
      OIDC_CLIENT_SECRET: "secret",
      SESSION_SECRET,
    });
    expect(config.oidc).toEqual({
      issuerUrl: "https://auth.example.com",
      clientId: "model-hub",
      clientSecret: "secret",
      redirectUrl: `${config.webBaseUrl}/auth/callback`,
    });
  });

  it("honors an explicit OIDC_REDIRECT_URL override", () => {
    const config = loadConfig({
      ...BASE_ENV,
      OIDC_ISSUER_URL: "https://auth.example.com",
      OIDC_CLIENT_ID: "model-hub",
      OIDC_CLIENT_SECRET: "secret",
      OIDC_REDIRECT_URL: "https://model-hub.example.com/auth/callback",
      SESSION_SECRET,
    });
    expect(config.oidc?.redirectUrl).toBe("https://model-hub.example.com/auth/callback");
  });

  it("fails fast when only some OIDC_* vars are set", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        OIDC_ISSUER_URL: "https://auth.example.com",
        OIDC_CLIENT_ID: "model-hub",
        SESSION_SECRET,
      }),
    ).toThrow(/OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must all be set together/);
  });

  it("fails fast when OIDC is configured but SESSION_SECRET is missing", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        OIDC_ISSUER_URL: "https://auth.example.com",
        OIDC_CLIENT_ID: "model-hub",
        OIDC_CLIENT_SECRET: "secret",
      }),
    ).toThrow(/SESSION_SECRET is required/);
  });

  it("applies sane defaults for rate limiting when unset", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.authRateLimitMax).toBe(10);
    expect(config.authRateLimitWindowMs).toBe(60_000);
    expect(config.uploadRateLimitMax).toBe(30);
    expect(config.uploadRateLimitWindowMs).toBe(60_000);
  });

  it("honors rate limit overrides", () => {
    const config = loadConfig({
      ...BASE_ENV,
      AUTH_RATE_LIMIT_MAX: "5",
      AUTH_RATE_LIMIT_WINDOW_MS: "30000",
      UPLOAD_RATE_LIMIT_MAX: "100",
      UPLOAD_RATE_LIMIT_WINDOW_MS: "120000",
    });
    expect(config.authRateLimitMax).toBe(5);
    expect(config.authRateLimitWindowMs).toBe(30_000);
    expect(config.uploadRateLimitMax).toBe(100);
    expect(config.uploadRateLimitWindowMs).toBe(120_000);
  });
});
