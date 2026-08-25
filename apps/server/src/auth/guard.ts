import type { UserRole } from "@model-hub/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { DbClient } from "../db/client.js";
import type { UserRow } from "../db/schema.js";
import { roleSatisfies } from "../lib/roles.js";
import { getUserByApiToken } from "./api-tokens.js";
import { readSessionCookie } from "./cookie.js";
import { INTERNAL_RENDER_HEADER, INTERNAL_RENDER_TOKEN } from "./internal-token.js";
import { ensureLocalOwner, getUserBySession } from "./session.js";

const BEARER_PREFIX = "Bearer ";

/** Extracts the token from an `Authorization: Bearer <token>` header, or null if absent/malformed. */
function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token || null;
}

/**
 * Resolves request.user for every request. In single-user mode (no OIDC
 * configured) every request is the synthetic local owner and nothing is ever
 * rejected — this is what keeps the rest of the app oblivious to which auth
 * mode it's running in (personal API tokens are still creatable in this
 * mode, since request.user is always set, but a bearer token is never
 * actually checked here — there's nothing to gate: every request already
 * succeeds regardless). In OIDC mode, unauthenticated requests to protected
 * /api/* routes get a 401; /api/auth/me is exempt so the frontend can always
 * ask "am I logged in?" without hitting the gate itself. An `Authorization:
 * Bearer <token>` header is checked before the session cookie, so a request
 * bearing a personal API token (auth/api-tokens.ts) authenticates AS that
 * token's owning user, with their *current* role — same as a session.
 */
export function registerAuthGuard(app: FastifyInstance, db: DbClient, config: Config): void {
  if (!config.oidc) {
    const localOwner = ensureLocalOwner(db);
    app.addHook("onRequest", async (request) => {
      request.user = localOwner;
    });
    return;
  }

  app.addHook("onRequest", async (request, reply) => {
    // The headless thumbnail worker's page never has a user session (see
    // internal-token.ts) — let its own file-fetch requests through.
    if (request.headers[INTERNAL_RENDER_HEADER] === INTERNAL_RENDER_TOKEN) {
      return;
    }

    const bearerToken = readBearerToken(request);
    let user: UserRow | null = null;
    if (bearerToken) {
      user = getUserByApiToken(db, bearerToken);
    } else {
      const sessionId = readSessionCookie(request);
      user = sessionId ? getUserBySession(db, sessionId) : null;
    }
    if (user) {
      request.user = user;
    }

    const isProtectedApiRoute =
      request.url.startsWith("/api/") && !request.url.startsWith("/api/auth/me");
    if (isProtectedApiRoute && !request.user) {
      return reply.code(401).send({ error: "authentication required" });
    }
  });
}

/**
 * Fastify preHandler that gates a route behind a minimum role — attach it
 * per-route (`{ preHandler: requireRole("admin") }`), not globally, since
 * most existing routes don't check role yet (see CLAUDE.md's Auth section:
 * this PR only wires it up on the new user/role-management and
 * settings-mapping routes; sweeping every other route is deliberately left
 * to future PRs that touch those routes anyway).
 *
 * Runs after registerAuthGuard's onRequest hook, so request.user is always
 * set by the time this runs (single-user mode: always the admin local
 * owner; OIDC mode: onRequest already 401'd an unauthenticated request to
 * any /api/* route). The `!request.user` branch below is defense in depth,
 * not a path this should ever actually hit.
 *
 * 403 (not 401) — the request IS authenticated, it just lacks permission.
 */
export function requireRole(minimumRole: UserRole) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: "authentication required" });
    }
    if (!roleSatisfies(request.user.role, minimumRole)) {
      return reply
        .code(403)
        .send({ error: `this action requires the "${minimumRole}" role or higher` });
    }
  };
}
