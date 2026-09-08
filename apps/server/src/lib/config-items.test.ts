import { beforeEach, describe, expect, it } from "vitest";
import { buildTestConfig } from "../test-support/config.js";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  buildConfigItems,
  deleteConfigOverride,
  getConfigOverrides,
  InvalidConfigKeyError,
  InvalidConfigValueError,
  setConfigOverride,
} from "./config-items.js";

describe("setConfigOverride / getConfigOverrides / deleteConfigOverride", () => {
  let db: DbClient;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);
  });

  it("rejects a key that isn't overridable", () => {
    expect(() => setConfigOverride(db, "LIBRARY_ROOT", "/some/path")).toThrow(InvalidConfigKeyError);
    expect(() => deleteConfigOverride(db, "DATABASE_PATH")).toThrow(InvalidConfigKeyError);
  });

  it("rejects a value that fails the field's type check", () => {
    expect(() => setConfigOverride(db, "THUMBNAIL_CONCURRENCY", "not-a-number")).toThrow(
      InvalidConfigValueError,
    );
    expect(() => setConfigOverride(db, "THUMBNAIL_CONCURRENCY", "-1")).toThrow(InvalidConfigValueError);
    expect(() => setConfigOverride(db, "LIBRARY_WATCH_ENABLED", "yes")).toThrow(InvalidConfigValueError);
    expect(() => setConfigOverride(db, "WEB_BASE_URL", "not a url")).toThrow(InvalidConfigValueError);
    expect(() => setConfigOverride(db, "THUMBNAIL_CONCURRENCY", "   ")).toThrow(InvalidConfigValueError);
  });

  it("sets, reads back, and clears an override", () => {
    setConfigOverride(db, "THUMBNAIL_CONCURRENCY", "4");
    expect(getConfigOverrides(db)).toEqual({ THUMBNAIL_CONCURRENCY: "4" });

    expect(deleteConfigOverride(db, "THUMBNAIL_CONCURRENCY")).toBe(true);
    expect(getConfigOverrides(db)).toEqual({});
  });

  it("upserts on a second set for the same key", () => {
    setConfigOverride(db, "LIBRARY_SCAN_INTERVAL_MS", "30000");
    setConfigOverride(db, "LIBRARY_SCAN_INTERVAL_MS", "45000");
    expect(getConfigOverrides(db)).toEqual({ LIBRARY_SCAN_INTERVAL_MS: "45000" });
  });

  it("deleteConfigOverride returns false when there was nothing to delete", () => {
    expect(deleteConfigOverride(db, "SYNC_DEBOUNCE_MS")).toBe(false);
  });
});

describe("buildConfigItems", () => {
  const baseConfig = buildTestConfig();

  it("marks a field as unset when there's no env, override, or default", () => {
    const items = buildConfigItems(baseConfig, {}, {});
    const item = items.find((i) => i.key === "OIDC_CLIENT_SECRET")!;
    expect(item.source).toBe("unset");
    expect(item.value).toBeNull();
  });

  it("masks a secret field once it has a value, without leaking it", () => {
    const config = buildTestConfig({
      oidc: {
        issuerUrl: "https://idp.example.com",
        clientId: "model-hub",
        clientSecret: "super-secret-value",
        redirectUrl: "http://localhost:4000/auth/callback",
      },
      sessionSecret: "a".repeat(32),
    });
    const items = buildConfigItems(config, { OIDC_CLIENT_SECRET: "super-secret-value" }, {});
    const item = items.find((i) => i.key === "OIDC_CLIENT_SECRET")!;
    expect(item.source).toBe("env");
    expect(item.value).not.toContain("super-secret-value");
    expect(item.secret).toBe(true);
  });

  it("shows a non-secret env-set value as-is and marks it non-editable", () => {
    const items = buildConfigItems(baseConfig, { LIBRARY_ROOT: "/library" }, {});
    const item = items.find((i) => i.key === "LIBRARY_ROOT")!;
    expect(item.source).toBe("env");
    expect(item.value).toBe(baseConfig.libraryRoot);
    expect(item.editable).toBe(false);
  });

  it("uses the schema/computed default when nothing else is set", () => {
    const items = buildConfigItems(baseConfig, {}, {});
    const item = items.find((i) => i.key === "PORT")!;
    expect(item.source).toBe("default");
    expect(item.value).toBe(String(baseConfig.port));
  });

  it("shows the override's own saved value, not the currently-running config value", () => {
    // The running process booted before this override was saved (it only
    // applies on the next restart -- see config.ts's applyConfigOverrides),
    // so `config` deliberately still reflects the OLD value (1) here while
    // the override says 4 -- the displayed value must be the override's.
    const config = buildTestConfig({ thumbnailConcurrency: 1 });
    const items = buildConfigItems(config, {}, { THUMBNAIL_CONCURRENCY: "4" });
    const item = items.find((i) => i.key === "THUMBNAIL_CONCURRENCY")!;
    expect(item.source).toBe("override");
    expect(item.editable).toBe(true);
    expect(item.value).toBe("4");
  });

  it("prefers env over a stale override for the same key", () => {
    const config = buildTestConfig({ thumbnailConcurrency: 2 });
    const items = buildConfigItems(config, { THUMBNAIL_CONCURRENCY: "2" }, { THUMBNAIL_CONCURRENCY: "4" });
    const item = items.find((i) => i.key === "THUMBNAIL_CONCURRENCY")!;
    expect(item.source).toBe("env");
  });
});
