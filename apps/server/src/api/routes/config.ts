import type { ConfigItem } from "@model-hub/shared";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../../auth/guard.js";
import type { Config } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import {
  buildConfigItems,
  deleteConfigOverride,
  getConfigOverrides,
  InvalidConfigKeyError,
  InvalidConfigValueError,
  setConfigOverride,
} from "../../lib/config-items.js";

/**
 * Admin-only Config viewer — see CLAUDE.md's Config section. `config` here
 * is the merged Config this process actually booted with (env + DB
 * overrides, see config.ts's applyConfigOverrides); process.env is only
 * consulted to tell an env-set value apart from a DB override or default —
 * see lib/config-items.ts's buildConfigItems.
 */
export function registerConfigRoutes(app: FastifyInstance, db: DbClient, config: Config): void {
  app.get("/api/admin/config", { preHandler: requireRole("admin") }, async (): Promise<ConfigItem[]> => {
    const overrides = getConfigOverrides(db);
    return buildConfigItems(config, process.env, overrides);
  });

  app.put<{ Params: { key: string }; Body: { value?: string } }>(
    "/api/admin/config/:key",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { key } = request.params;
      const { value } = request.body ?? {};
      if (typeof value !== "string") {
        return reply.code(400).send({ error: "value is required" });
      }

      const overridesBefore = getConfigOverrides(db);
      const current = buildConfigItems(config, process.env, overridesBefore).find((item) => item.key === key);
      if (!current) {
        return reply.code(400).send({ error: `unknown config key "${key}"` });
      }
      if (current.source === "env") {
        return reply.code(400).send({ error: `${key} is set via environment variable and cannot be overridden here` });
      }

      try {
        setConfigOverride(db, key, value);
      } catch (err) {
        if (err instanceof InvalidConfigKeyError || err instanceof InvalidConfigValueError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }

      const overridesAfter = getConfigOverrides(db);
      return buildConfigItems(config, process.env, overridesAfter).find((item) => item.key === key);
    },
  );

  app.delete<{ Params: { key: string } }>(
    "/api/admin/config/:key",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { key } = request.params;
      try {
        deleteConfigOverride(db, key);
      } catch (err) {
        if (err instanceof InvalidConfigKeyError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }

      const overrides = getConfigOverrides(db);
      const item = buildConfigItems(config, process.env, overrides).find((i) => i.key === key);
      return item ?? reply.code(404).send({ error: `unknown config key "${key}"` });
    },
  );
}
