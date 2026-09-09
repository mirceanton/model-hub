import { describe, expect, it } from "vitest";
import { applyConfigOverrides, loadConfig } from "./config.js";

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

  describe("OIDC_ADMIN_GROUPS", () => {
    it("defaults to an empty array when unset", () => {
      const config = loadConfig(BASE_ENV);
      expect(config.oidcAdminGroups).toEqual([]);
    });

    it("defaults to an empty array when set to an empty string", () => {
      const config = loadConfig({ ...BASE_ENV, OIDC_ADMIN_GROUPS: "" });
      expect(config.oidcAdminGroups).toEqual([]);
    });

    it("parses a single group", () => {
      const config = loadConfig({ ...BASE_ENV, OIDC_ADMIN_GROUPS: "platform-admins" });
      expect(config.oidcAdminGroups).toEqual(["platform-admins"]);
    });

    it("parses multiple comma-separated groups", () => {
      const config = loadConfig({ ...BASE_ENV, OIDC_ADMIN_GROUPS: "platform-admins,3d-printing-admins" });
      expect(config.oidcAdminGroups).toEqual(["platform-admins", "3d-printing-admins"]);
    });

    it("trims surrounding whitespace around each group name", () => {
      const config = loadConfig({ ...BASE_ENV, OIDC_ADMIN_GROUPS: "  platform-admins , 3d-printing-admins  " });
      expect(config.oidcAdminGroups).toEqual(["platform-admins", "3d-printing-admins"]);
    });

    it("fails fast with a clear error when an entry is empty (e.g. a stray comma)", () => {
      expect(() => loadConfig({ ...BASE_ENV, OIDC_ADMIN_GROUPS: "foo,,bar" })).toThrow(/OIDC_ADMIN_GROUPS/);
    });
  });

  describe("OIDC_EDITOR_GROUPS", () => {
    it("defaults to an empty array when unset", () => {
      const config = loadConfig(BASE_ENV);
      expect(config.oidcEditorGroups).toEqual([]);
    });

    it("parses multiple comma-separated groups", () => {
      const config = loadConfig({ ...BASE_ENV, OIDC_EDITOR_GROUPS: "3d-printing-editors, contributors" });
      expect(config.oidcEditorGroups).toEqual(["3d-printing-editors", "contributors"]);
    });

    it("fails fast with a clear error when an entry is empty", () => {
      expect(() => loadConfig({ ...BASE_ENV, OIDC_EDITOR_GROUPS: "foo,,bar" })).toThrow(/OIDC_EDITOR_GROUPS/);
    });
  });

  it("fails fast when the same group is listed under both OIDC_ADMIN_GROUPS and OIDC_EDITOR_GROUPS", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, OIDC_ADMIN_GROUPS: "platform", OIDC_EDITOR_GROUPS: "platform" }),
    ).toThrow(/"platform" is listed in both OIDC_ADMIN_GROUPS and OIDC_EDITOR_GROUPS/);
  });

  describe("OIDC_READONLY_GROUPS", () => {
    it("defaults to an empty array when unset", () => {
      const config = loadConfig(BASE_ENV);
      expect(config.oidcReadonlyGroups).toEqual([]);
    });

    it("parses multiple comma-separated groups", () => {
      const config = loadConfig({ ...BASE_ENV, OIDC_READONLY_GROUPS: "3d-printing-readers, guests" });
      expect(config.oidcReadonlyGroups).toEqual(["3d-printing-readers", "guests"]);
    });

    it("fails fast with a clear error when an entry is empty", () => {
      expect(() => loadConfig({ ...BASE_ENV, OIDC_READONLY_GROUPS: "foo,,bar" })).toThrow(/OIDC_READONLY_GROUPS/);
    });
  });

  it("fails fast when the same group is listed under both OIDC_ADMIN_GROUPS and OIDC_READONLY_GROUPS", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, OIDC_ADMIN_GROUPS: "platform", OIDC_READONLY_GROUPS: "platform" }),
    ).toThrow(/"platform" is listed in both OIDC_ADMIN_GROUPS and OIDC_READONLY_GROUPS/);
  });

  describe("OIDC_GROUPS_CLAIM / OIDC_DEFAULT_ROLE", () => {
    it("default to null when unset", () => {
      const config = loadConfig(BASE_ENV);
      expect(config.oidcGroupsClaim).toBeNull();
      expect(config.oidcDefaultRole).toBeNull();
    });

    it("are parsed when set", () => {
      const config = loadConfig({ ...BASE_ENV, OIDC_GROUPS_CLAIM: "roles", OIDC_DEFAULT_ROLE: "editor" });
      expect(config.oidcGroupsClaim).toBe("roles");
      expect(config.oidcDefaultRole).toBe("editor");
    });

    it("rejects an unknown OIDC_DEFAULT_ROLE value", () => {
      expect(() => loadConfig({ ...BASE_ENV, OIDC_DEFAULT_ROLE: "superadmin" })).toThrow();
    });
  });
});

describe("applyConfigOverrides", () => {
  it("merges an override in when the env var is unset", () => {
    const config = loadConfig(BASE_ENV);
    const merged = applyConfigOverrides(config, { THUMBNAIL_CONCURRENCY: "4" }, BASE_ENV);
    expect(merged.thumbnailConcurrency).toBe(4);
  });

  it("lets env win over a stale override for the same key", () => {
    const env = { ...BASE_ENV, THUMBNAIL_CONCURRENCY: "2" };
    const config = loadConfig(env);
    const merged = applyConfigOverrides(config, { THUMBNAIL_CONCURRENCY: "4" }, env);
    expect(merged.thumbnailConcurrency).toBe(2);
  });

  it("leaves fields with no override untouched", () => {
    const config = loadConfig(BASE_ENV);
    const merged = applyConfigOverrides(config, {}, BASE_ENV);
    expect(merged).toEqual(config);
  });

  it("merges boolean and string overrides", () => {
    const config = loadConfig(BASE_ENV);
    const merged = applyConfigOverrides(
      config,
      { LIBRARY_WATCH_ENABLED: "false", WEB_BASE_URL: "http://example.com" },
      BASE_ENV,
    );
    expect(merged.libraryWatchEnabled).toBe(false);
    expect(merged.webBaseUrl).toBe("http://example.com");
  });
});
