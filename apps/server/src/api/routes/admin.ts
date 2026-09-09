import type { AdminUser, OidcRoleMapping, OidcRoleMappingConfig, UserRole } from "@model-hub/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../../auth/guard.js";
import type { Config } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import { users as usersTable, type UserRow } from "../../db/schema.js";
import {
  createGroupRoleMapping,
  deleteGroupRoleMapping,
  DuplicateGroupMappingError,
  ensureAuthSettings,
  getGroupRoleMappings,
  InvalidGroupNameError,
  InvalidRoleError,
  parseDefaultRoleSetting,
  parseRole,
  updateAuthSettings,
  updateGroupRoleMapping,
} from "../../lib/auth-settings.js";

function toAdminUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isLocalOwner: row.isLocalOwner,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * Maps each env-enforced group name (config.ts's oidcAdminGroups/
 * oidcEditorGroups/oidcReadonlyGroups) to the env var that enforces it, for
 * tagging API responses so the admin UI can show why a mapping can't be
 * edited here — see lib/auth-settings.ts's enforceGroupRoleMappings, which
 * this mirrors.
 */
function buildGroupLockMap(config: Config): Map<string, string> {
  const lockedByGroup = new Map<string, string>();
  for (const groupName of config.oidcAdminGroups) lockedByGroup.set(groupName, "OIDC_ADMIN_GROUPS");
  for (const groupName of config.oidcEditorGroups) lockedByGroup.set(groupName, "OIDC_EDITOR_GROUPS");
  for (const groupName of config.oidcReadonlyGroups) lockedByGroup.set(groupName, "OIDC_READONLY_GROUPS");
  return lockedByGroup;
}

function toApiMapping(
  row: { id: number; groupName: string; role: UserRole },
  lockedByGroup: Map<string, string>,
): OidcRoleMapping {
  return { id: row.id, groupName: row.groupName, role: row.role, lockedBy: lockedByGroup.get(row.groupName) ?? null };
}

/**
 * Admin-only user/role management and OIDC-group-to-role mapping config —
 * see CLAUDE.md's Auth section. requireRole("admin") is demonstrated here
 * (and nowhere else yet — see guard.ts's requireRole doc comment for why).
 */
export function registerAdminRoutes(app: FastifyInstance, db: DbClient, config: Config): void {
  app.get("/api/admin/users", { preHandler: requireRole("admin") }, async () => {
    const rows = db.select().from(usersTable).orderBy(usersTable.createdAt).all();
    return rows.map(toAdminUser);
  });

  app.delete<{ Params: { id: string } }>(
    "/api/admin/users/:id",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid user id" });
      }
      if (id === request.user?.id) {
        return reply.code(400).send({ error: "cannot delete your own account" });
      }

      const target = db.select().from(usersTable).where(eq(usersTable.id, id)).get();
      if (!target) {
        return reply.code(404).send({ error: "user not found" });
      }
      if (target.isLocalOwner) {
        return reply.code(400).send({ error: "cannot delete the local owner account" });
      }

      // sessions.userId and personal_access_tokens.userId both cascade on
      // delete (schema.ts), so this also removes the user's sessions/tokens.
      db.delete(usersTable).where(eq(usersTable.id, id)).run();
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/admin/role-mapping",
    { preHandler: requireRole("admin") },
    async (): Promise<OidcRoleMappingConfig> => {
      const settings = ensureAuthSettings(db);
      const mappings = getGroupRoleMappings(db);
      const lockedByGroup = buildGroupLockMap(config);
      return {
        groupsClaim: settings.oidcGroupsClaim,
        groupsClaimLockedBy: config.oidcGroupsClaim ? "OIDC_GROUPS_CLAIM" : null,
        defaultRole: settings.defaultRole,
        defaultRoleLockedBy: config.oidcDefaultRole !== undefined ? "OIDC_DEFAULT_ROLE" : null,
        mappings: mappings.map((m) => toApiMapping(m, lockedByGroup)),
      };
    },
  );

  app.patch<{ Body: { groupsClaim?: string; defaultRole?: string } }>(
    "/api/admin/role-mapping/settings",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { groupsClaim, defaultRole: rawDefaultRole } = request.body ?? {};

      if (groupsClaim !== undefined && config.oidcGroupsClaim) {
        return reply.code(400).send({ error: "groupsClaim is set via OIDC_GROUPS_CLAIM and cannot be changed here" });
      }
      if (rawDefaultRole !== undefined && config.oidcDefaultRole !== undefined) {
        return reply.code(400).send({ error: "defaultRole is set via OIDC_DEFAULT_ROLE and cannot be changed here" });
      }

      let defaultRole: UserRole | null | undefined;
      try {
        if (rawDefaultRole !== undefined) {
          defaultRole = parseDefaultRoleSetting(rawDefaultRole);
        }
        const updated = updateAuthSettings(db, { groupsClaim, defaultRole });
        return {
          groupsClaim: updated.oidcGroupsClaim,
          groupsClaimLockedBy: config.oidcGroupsClaim ? "OIDC_GROUPS_CLAIM" : null,
          defaultRole: updated.defaultRole,
          defaultRoleLockedBy: config.oidcDefaultRole !== undefined ? "OIDC_DEFAULT_ROLE" : null,
        };
      } catch (err) {
        if (err instanceof InvalidRoleError || err instanceof InvalidGroupNameError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Body: { groupName?: string; role?: string } }>(
    "/api/admin/role-mapping/groups",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { groupName, role: rawRole } = request.body ?? {};
      if (!groupName) {
        return reply.code(400).send({ error: "groupName is required" });
      }
      if (!rawRole) {
        return reply.code(400).send({ error: "role is required" });
      }
      const lockedByGroup = buildGroupLockMap(config);
      const lockedBy = lockedByGroup.get(groupName.trim());
      if (lockedBy) {
        return reply.code(400).send({ error: `"${groupName}" is force-mapped via ${lockedBy} and cannot be set here` });
      }

      try {
        const role = parseRole(rawRole);
        const mapping = createGroupRoleMapping(db, groupName, role);
        return reply.code(201).send(toApiMapping(mapping, lockedByGroup));
      } catch (err) {
        if (
          err instanceof InvalidRoleError ||
          err instanceof InvalidGroupNameError ||
          err instanceof DuplicateGroupMappingError
        ) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { role?: string } }>(
    "/api/admin/role-mapping/groups/:id",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid mapping id" });
      }
      const rawRole = request.body?.role;
      if (!rawRole) {
        return reply.code(400).send({ error: "role is required" });
      }

      const lockedByGroup = buildGroupLockMap(config);
      const existing = getGroupRoleMappings(db).find((m) => m.id === id);
      const lockedBy = existing ? lockedByGroup.get(existing.groupName) : undefined;
      if (lockedBy) {
        return reply.code(400).send({ error: `"${existing!.groupName}" is force-mapped via ${lockedBy} and cannot be changed here` });
      }

      try {
        const role = parseRole(rawRole);
        const mapping = updateGroupRoleMapping(db, id, role);
        if (!mapping) {
          return reply.code(404).send({ error: "mapping not found" });
        }
        return toApiMapping(mapping, lockedByGroup);
      } catch (err) {
        if (err instanceof InvalidRoleError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/admin/role-mapping/groups/:id",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid mapping id" });
      }

      const lockedByGroup = buildGroupLockMap(config);
      const existing = getGroupRoleMappings(db).find((m) => m.id === id);
      const lockedBy = existing ? lockedByGroup.get(existing.groupName) : undefined;
      if (lockedBy) {
        return reply.code(400).send({ error: `"${existing!.groupName}" is force-mapped via ${lockedBy} and cannot be removed here` });
      }

      const deleted = deleteGroupRoleMapping(db, id);
      if (!deleted) {
        return reply.code(404).send({ error: "mapping not found" });
      }
      return reply.code(204).send();
    },
  );
}
