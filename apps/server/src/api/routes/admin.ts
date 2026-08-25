import type { AdminUser, OidcRoleMapping, OidcRoleMappingConfig, UserRole } from "@model-hub/shared";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../../auth/guard.js";
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

function toApiMapping(row: { id: number; groupName: string; role: UserRole }): OidcRoleMapping {
  return { id: row.id, groupName: row.groupName, role: row.role };
}

/**
 * Admin-only user/role management and OIDC-group-to-role mapping config —
 * see CLAUDE.md's Auth section. requireRole("admin") is demonstrated here
 * (and nowhere else yet — see guard.ts's requireRole doc comment for why).
 */
export function registerAdminRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/admin/users", { preHandler: requireRole("admin") }, async () => {
    const rows = db.select().from(usersTable).orderBy(usersTable.createdAt).all();
    return rows.map(toAdminUser);
  });

  app.get(
    "/api/admin/role-mapping",
    { preHandler: requireRole("admin") },
    async (): Promise<OidcRoleMappingConfig> => {
      const settings = ensureAuthSettings(db);
      const mappings = getGroupRoleMappings(db);
      return {
        groupsClaim: settings.oidcGroupsClaim,
        defaultRole: settings.defaultRole,
        mappings: mappings.map(toApiMapping),
      };
    },
  );

  app.patch<{ Body: { groupsClaim?: string; defaultRole?: string } }>(
    "/api/admin/role-mapping/settings",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { groupsClaim, defaultRole: rawDefaultRole } = request.body ?? {};

      let defaultRole: UserRole | undefined;
      try {
        if (rawDefaultRole !== undefined) {
          defaultRole = parseRole(rawDefaultRole);
        }
        const updated = updateAuthSettings(db, { groupsClaim, defaultRole });
        return { groupsClaim: updated.oidcGroupsClaim, defaultRole: updated.defaultRole };
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

      try {
        const role = parseRole(rawRole);
        const mapping = createGroupRoleMapping(db, groupName, role);
        return reply.code(201).send(toApiMapping(mapping));
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

      try {
        const role = parseRole(rawRole);
        const mapping = updateGroupRoleMapping(db, id, role);
        if (!mapping) {
          return reply.code(404).send({ error: "mapping not found" });
        }
        return toApiMapping(mapping);
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

      const deleted = deleteGroupRoleMapping(db, id);
      if (!deleted) {
        return reply.code(404).send({ error: "mapping not found" });
      }
      return reply.code(204).send();
    },
  );
}
