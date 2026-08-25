import type { UserRole } from "@model-hub/shared";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import {
  authSettings as authSettingsTable,
  oidcGroupRoleMappings as mappingsTable,
  type AuthSettingsRow,
  type OidcGroupRoleMappingRow,
} from "../db/schema.js";
import { isUserRole } from "./roles.js";

export class InvalidGroupNameError extends Error {}
export class InvalidRoleError extends Error {}
export class DuplicateGroupMappingError extends Error {}

const MAX_GROUP_NAME_LENGTH = 200;

export function normalizeGroupName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    throw new InvalidGroupNameError("group name cannot be empty");
  }
  if (trimmed.length > MAX_GROUP_NAME_LENGTH) {
    throw new InvalidGroupNameError(`group name cannot exceed ${MAX_GROUP_NAME_LENGTH} characters`);
  }
  return trimmed;
}

export function parseRole(rawRole: string): UserRole {
  if (!isUserRole(rawRole)) {
    throw new InvalidRoleError('role must be one of "admin", "editor", "viewer"');
  }
  return rawRole;
}

/**
 * Singleton row holding the instance-wide OIDC role-mapping config (the
 * groups-claim name and the fallback role) — created on first use, same
 * pattern as session.ts's ensureLocalOwner.
 */
export function ensureAuthSettings(db: DbClient): AuthSettingsRow {
  const existing = db.select().from(authSettingsTable).get();
  if (existing) return existing;

  return db
    .insert(authSettingsTable)
    .values({ oidcGroupsClaim: "groups", defaultRole: "viewer", updatedAt: new Date() })
    .returning()
    .get();
}

export function updateAuthSettings(
  db: DbClient,
  patch: { groupsClaim?: string; defaultRole?: UserRole },
): AuthSettingsRow {
  const current = ensureAuthSettings(db);

  const groupsClaim = patch.groupsClaim !== undefined ? patch.groupsClaim.trim() : current.oidcGroupsClaim;
  if (!groupsClaim) {
    throw new InvalidGroupNameError("groupsClaim cannot be empty");
  }

  return db
    .update(authSettingsTable)
    .set({
      oidcGroupsClaim: groupsClaim,
      defaultRole: patch.defaultRole ?? current.defaultRole,
      updatedAt: new Date(),
    })
    .where(eq(authSettingsTable.id, current.id))
    .returning()
    .get();
}

export function getGroupRoleMappings(db: DbClient): OidcGroupRoleMappingRow[] {
  return db.select().from(mappingsTable).orderBy(mappingsTable.groupName).all();
}

/** Creates a new group->role mapping. Throws if the group name is already mapped (use updateGroupRoleMapping to change its role). */
export function createGroupRoleMapping(
  db: DbClient,
  rawGroupName: string,
  role: UserRole,
): OidcGroupRoleMappingRow {
  const groupName = normalizeGroupName(rawGroupName);
  const existing = db.select().from(mappingsTable).where(eq(mappingsTable.groupName, groupName)).get();
  if (existing) {
    throw new DuplicateGroupMappingError(`group "${groupName}" is already mapped`);
  }

  const now = new Date();
  return db
    .insert(mappingsTable)
    .values({ groupName, role, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

/** Returns undefined if the mapping doesn't exist. */
export function updateGroupRoleMapping(
  db: DbClient,
  id: number,
  role: UserRole,
): OidcGroupRoleMappingRow | undefined {
  return db
    .update(mappingsTable)
    .set({ role, updatedAt: new Date() })
    .where(eq(mappingsTable.id, id))
    .returning()
    .get();
}

/** Returns false if the mapping didn't exist. */
export function deleteGroupRoleMapping(db: DbClient, id: number): boolean {
  const result = db.delete(mappingsTable).where(eq(mappingsTable.id, id)).run();
  return result.changes > 0;
}

/**
 * Force-upserts each of the given OIDC group names to the `admin` role --
 * "the env var always wins." Called at every boot (see index.ts) when
 * OIDC_ADMIN_GROUPS is set, to bootstrap out of the lockout where the
 * group-mapping table starts empty and nobody can reach the /admin UI that
 * would otherwise configure it. Idempotent: a group with no existing
 * mapping row gets one inserted as admin; a group already mapped to a
 * different role gets updated to admin; a group already correctly mapped
 * to admin is left untouched (no unnecessary updatedAt bump). Mappings for
 * groups NOT in `groupNames` are never touched.
 *
 * By the time this runs, config.ts's loadConfig has already validated each
 * name via normalizeGroupName -- this call is defense in depth, not the
 * primary validation point.
 */
export function enforceAdminGroupMappings(db: DbClient, groupNames: string[]): void {
  const now = new Date();
  for (const rawGroupName of groupNames) {
    const groupName = normalizeGroupName(rawGroupName);
    const existing = db.select().from(mappingsTable).where(eq(mappingsTable.groupName, groupName)).get();

    if (!existing) {
      db.insert(mappingsTable).values({ groupName, role: "admin", createdAt: now, updatedAt: now }).run();
    } else if (existing.role !== "admin") {
      db.update(mappingsTable).set({ role: "admin", updatedAt: now }).where(eq(mappingsTable.id, existing.id)).run();
    }
  }
}
