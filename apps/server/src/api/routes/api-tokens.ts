import type { ApiToken, ApiTokenCreated } from "@model-hub/shared";
import type { FastifyInstance } from "fastify";
import {
  createApiToken,
  InvalidTokenLabelError,
  listApiTokens,
  revokeApiToken,
} from "../../auth/api-tokens.js";
import type { DbClient } from "../../db/client.js";
import type { PersonalAccessTokenRow } from "../../db/schema.js";

function toApiToken(row: PersonalAccessTokenRow): ApiToken {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
  };
}

/**
 * Self-service personal API tokens (see CLAUDE.md's Auth section) — every
 * authenticated user manages only their own, scoped to request.user.id both
 * here and in auth/api-tokens.ts's listApiTokens/revokeApiToken. No
 * requireRole gate: a token inherits its owner's role wherever it's used
 * later (guard.ts), so restricting *creation* by role would be redundant —
 * a viewer's token is still only ever a viewer everywhere else.
 *
 * The `!request.user` checks below are defense in depth, matching
 * requireRole's own doc comment in guard.ts — registerAuthGuard's onRequest
 * hook already 401s an unauthenticated request to any /api/* route (or, in
 * single-user mode, request.user is always the local owner).
 */
export function registerApiTokenRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/tokens", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });

    const rows = listApiTokens(db, request.user.id);
    return rows.map(toApiToken);
  });

  app.post<{ Body: { label?: string; expiresAt?: number } }>(
    "/api/tokens",
    async (request, reply) => {
      if (!request.user) return reply.code(401).send({ error: "authentication required" });

      const { label, expiresAt: rawExpiresAt } = request.body ?? {};
      if (!label || !label.trim()) {
        return reply.code(400).send({ error: "label is required" });
      }
      if (rawExpiresAt !== undefined && (!Number.isFinite(rawExpiresAt) || rawExpiresAt <= Date.now())) {
        return reply.code(400).send({ error: "expiresAt must be a future timestamp" });
      }

      try {
        const created = createApiToken(
          db,
          request.user.id,
          label,
          rawExpiresAt !== undefined ? new Date(rawExpiresAt) : null,
        );
        const result: ApiTokenCreated = {
          id: created.id,
          label: created.label,
          createdAt: created.createdAt.getTime(),
          expiresAt: created.expiresAt ? created.expiresAt.getTime() : null,
          lastUsedAt: null,
          token: created.token,
        };
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof InvalidTokenLabelError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>("/api/tokens/:id", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });

    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid token id" });
    }

    const revoked = revokeApiToken(db, request.user.id, id);
    if (!revoked) {
      return reply.code(404).send({ error: "token not found" });
    }
    return reply.code(204).send();
  });
}
