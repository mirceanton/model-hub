import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { authSettings as authSettingsTable, oidcGroupRoleMappings as mappingsTable } from "../db/schema.js";
import {
  enforceAuthSettingsFromEnv,
  enforceGroupRoleMappings,
  ensureAuthSettings,
  InvalidGroupNameError,
  InvalidRoleError,
  normalizeGroupName,
  parseRole,
} from "./auth-settings.js";

describe("normalizeGroupName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeGroupName("  3d-printing-admins  ")).toBe("3d-printing-admins");
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(() => normalizeGroupName("")).toThrow(InvalidGroupNameError);
    expect(() => normalizeGroupName("   ")).toThrow(InvalidGroupNameError);
  });

  it("rejects a name longer than 200 characters", () => {
    expect(() => normalizeGroupName("a".repeat(201))).toThrow(InvalidGroupNameError);
  });

  it("accepts a name at exactly the length limit", () => {
    expect(normalizeGroupName("a".repeat(200))).toBe("a".repeat(200));
  });
});

describe("parseRole", () => {
  it("accepts the three known roles", () => {
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("editor")).toBe("editor");
    expect(parseRole("viewer")).toBe("viewer");
  });

  it("rejects an unknown role", () => {
    expect(() => parseRole("superadmin")).toThrow(InvalidRoleError);
    expect(() => parseRole("")).toThrow(InvalidRoleError);
  });
});

describe("enforceGroupRoleMappings", () => {
  let db: DbClient;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);
  });

  function getMapping(groupName: string) {
    return db.select().from(mappingsTable).where(eq(mappingsTable.groupName, groupName)).get();
  }

  it("creates a new mapping for a previously-unmapped group", () => {
    enforceGroupRoleMappings(db, { admin: ["platform-admins"] });

    const mapping = getMapping("platform-admins");
    expect(mapping?.role).toBe("admin");
  });

  it("overwrites an existing mapping to the enforced role", () => {
    const now = new Date();
    db.insert(mappingsTable).values({ groupName: "platform-admins", role: "viewer", createdAt: now, updatedAt: now }).run();

    enforceGroupRoleMappings(db, { admin: ["platform-admins"] });

    const mapping = getMapping("platform-admins");
    expect(mapping?.role).toBe("admin");
  });

  it("is a no-op when called twice in a row with the same already-enforced groups", () => {
    enforceGroupRoleMappings(db, { admin: ["platform-admins"] });
    const first = getMapping("platform-admins")!;

    enforceGroupRoleMappings(db, { admin: ["platform-admins"] });
    const second = getMapping("platform-admins")!;

    expect(second.role).toBe("admin");
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    expect(db.select().from(mappingsTable).all()).toHaveLength(1);
  });

  it("leaves mappings for groups named by no role list completely untouched", () => {
    const now = new Date();
    db.insert(mappingsTable).values({ groupName: "editors", role: "editor", createdAt: now, updatedAt: now }).run();

    enforceGroupRoleMappings(db, { admin: ["platform-admins"] });

    const editorsMapping = getMapping("editors");
    expect(editorsMapping?.role).toBe("editor");
    expect(editorsMapping?.updatedAt.getTime()).toBe(now.getTime());
  });

  it("enforces multiple roles at once, each to its own groups", () => {
    enforceGroupRoleMappings(db, { admin: ["platform-admins"], editor: ["3d-printing-editors"] });

    expect(getMapping("platform-admins")?.role).toBe("admin");
    expect(getMapping("3d-printing-editors")?.role).toBe("editor");
  });
});

describe("enforceAuthSettingsFromEnv", () => {
  let db: DbClient;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);
  });

  it("forces groupsClaim when provided", () => {
    enforceAuthSettingsFromEnv(db, { groupsClaim: "roles" });
    expect(ensureAuthSettings(db).oidcGroupsClaim).toBe("roles");
  });

  it("forces defaultRole when provided", () => {
    enforceAuthSettingsFromEnv(db, { defaultRole: "editor" });
    expect(ensureAuthSettings(db).defaultRole).toBe("editor");
  });

  it("overwrites a value previously configured via the admin UI", () => {
    db.insert(authSettingsTable)
      .values({ oidcGroupsClaim: "custom-claim", defaultRole: "admin", updatedAt: new Date() })
      .run();

    enforceAuthSettingsFromEnv(db, { groupsClaim: "groups", defaultRole: "viewer" });

    const settings = ensureAuthSettings(db);
    expect(settings.oidcGroupsClaim).toBe("groups");
    expect(settings.defaultRole).toBe("viewer");
  });

  it("leaves a field untouched when not provided", () => {
    db.insert(authSettingsTable)
      .values({ oidcGroupsClaim: "custom-claim", defaultRole: "admin", updatedAt: new Date() })
      .run();

    enforceAuthSettingsFromEnv(db, { defaultRole: "viewer" });

    const settings = ensureAuthSettings(db);
    expect(settings.oidcGroupsClaim).toBe("custom-claim");
    expect(settings.defaultRole).toBe("viewer");
  });

  it("is a no-op (no updatedAt bump) when called twice with the same values", () => {
    enforceAuthSettingsFromEnv(db, { groupsClaim: "roles", defaultRole: "editor" });
    const first = ensureAuthSettings(db);

    enforceAuthSettingsFromEnv(db, { groupsClaim: "roles", defaultRole: "editor" });
    const second = ensureAuthSettings(db);

    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });
});
