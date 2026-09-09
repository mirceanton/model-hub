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

/** The API/env spelling of "no default role" (see parseDefaultRoleSetting). */
export const DENY_DEFAULT_ROLE = "deny";

/**
 * Like parseRole, but also accepts "deny" (-> null), the settings.defaultRole
 * value meaning "unmatched users are refused login entirely" -- see
 * lib/roles.ts's resolveRoleFromGroups and auth/session.ts's
 * AccessDeniedError.
 */
export function parseDefaultRoleSetting(raw: string): UserRole | null {
  if (raw === DENY_DEFAULT_ROLE) return null;
  return parseRole(raw);
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
  patch: { groupsClaim?: string; defaultRole?: UserRole | null },
): AuthSettingsRow {
  const current = ensureAuthSettings(db);

  const groupsClaim = patch.groupsClaim !== undefined ? patch.groupsClaim.trim() : current.oidcGroupsClaim;
  if (!groupsClaim) {
    throw new InvalidGroupNameError("groupsClaim cannot be empty");
  }
  // `defaultRole` is `UserRole | null` (null = deny), so `??` would wrongly
  // discard an explicit null -- only an omitted key falls back to `current`.
  const defaultRole = patch.defaultRole !== undefined ? patch.defaultRole : current.defaultRole;

  return db
    .update(authSettingsTable)
    .set({ oidcGroupsClaim: groupsClaim, defaultRole, updatedAt: new Date() })
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
 * Force-upserts each OIDC group name in `groupNamesByRole` to that role --
 * "the env var always wins." Called at every boot (see index.ts) for each of
 * OIDC_ADMIN_GROUPS/OIDC_EDITOR_GROUPS/OIDC_READONLY_GROUPS that's set. The
 * admin case doubles as the bootstrap escape hatch out of the lockout where
 * the group-mapping table starts empty and nobody can reach the /admin UI
 * that would otherwise configure it. Idempotent: a group with no existing
 * mapping row gets one inserted; a group already mapped to a different role
 * gets updated; a group already correctly mapped is left untouched (no
 * unnecessary updatedAt bump). Mappings for groups not named by any of these
 * lists are never touched.
 *
 * By the time this runs, config.ts's loadConfig has already validated each
 * name via normalizeGroupName and confirmed no group appears under more than
 * one role -- this call is defense in depth, not the primary validation
 * point.
 */
export function enforceGroupRoleMappings(db: DbClient, groupNamesByRole: Partial<Record<UserRole, string[]>>): void {
  const now = new Date();
  for (const [role, groupNames] of Object.entries(groupNamesByRole) as [UserRole, string[] | undefined][]) {
    for (const rawGroupName of groupNames ?? []) {
      const groupName = normalizeGroupName(rawGroupName);
      const existing = db.select().from(mappingsTable).where(eq(mappingsTable.groupName, groupName)).get();

      if (!existing) {
        db.insert(mappingsTable).values({ groupName, role, createdAt: now, updatedAt: now }).run();
      } else if (existing.role !== role) {
        db.update(mappingsTable).set({ role, updatedAt: now }).where(eq(mappingsTable.id, existing.id)).run();
      }
    }
  }
}

/**
 * Force-writes the singleton auth-settings row's groupsClaim/defaultRole
 * from env-sourced values -- "the env var always wins," same pattern as
 * enforceGroupRoleMappings above. Called at every boot (see index.ts) when
 * OIDC_GROUPS_CLAIM and/or OIDC_DEFAULT_ROLE are set; a field left
 * `undefined` here is untouched (still editable via the /admin UI). Skips
 * the write entirely when nothing would change, to avoid an unnecessary
 * updatedAt bump on every restart.
 */
export function enforceAuthSettingsFromEnv(
  db: DbClient,
  patch: { groupsClaim?: string; defaultRole?: UserRole | null },
): void {
  const current = ensureAuthSettings(db);
  const groupsClaim = patch.groupsClaim ?? current.oidcGroupsClaim;
  // `defaultRole` is `UserRole | null` (null = deny/OIDC_DEFAULT_ROLE=deny),
  // so `??` would wrongly discard an explicit null -- only an omitted key
  // (env unset) falls back to `current`.
  const defaultRole = patch.defaultRole !== undefined ? patch.defaultRole : current.defaultRole;
  if (groupsClaim === current.oidcGroupsClaim && defaultRole === current.defaultRole) return;

  db.update(authSettingsTable)
    .set({ oidcGroupsClaim: groupsClaim, defaultRole, updatedAt: new Date() })
    .where(eq(authSettingsTable.id, current.id))
    .run();
}
