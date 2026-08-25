import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { oidcGroupRoleMappings as mappingsTable } from "../db/schema.js";
import {
  enforceAdminGroupMappings,
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

describe("enforceAdminGroupMappings", () => {
  let db: DbClient;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);
  });

  function getMapping(groupName: string) {
    return db.select().from(mappingsTable).where(eq(mappingsTable.groupName, groupName)).get();
  }

  it("creates a new mapping for a previously-unmapped group", () => {
    enforceAdminGroupMappings(db, ["platform-admins"]);

    const mapping = getMapping("platform-admins");
    expect(mapping?.role).toBe("admin");
  });

  it("overwrites an existing non-admin mapping to admin", () => {
    const now = new Date();
    db.insert(mappingsTable).values({ groupName: "platform-admins", role: "viewer", createdAt: now, updatedAt: now }).run();

    enforceAdminGroupMappings(db, ["platform-admins"]);

    const mapping = getMapping("platform-admins");
    expect(mapping?.role).toBe("admin");
  });

  it("is a no-op when called twice in a row with the same already-admin groups", () => {
    enforceAdminGroupMappings(db, ["platform-admins"]);
    const first = getMapping("platform-admins")!;

    enforceAdminGroupMappings(db, ["platform-admins"]);
    const second = getMapping("platform-admins")!;

    expect(second.role).toBe("admin");
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    expect(db.select().from(mappingsTable).all()).toHaveLength(1);
  });

  it("leaves mappings for other groups completely untouched", () => {
    const now = new Date();
    db.insert(mappingsTable).values({ groupName: "editors", role: "editor", createdAt: now, updatedAt: now }).run();

    enforceAdminGroupMappings(db, ["platform-admins"]);

    const editorsMapping = getMapping("editors");
    expect(editorsMapping?.role).toBe("editor");
    expect(editorsMapping?.updatedAt.getTime()).toBe(now.getTime());
  });
});
