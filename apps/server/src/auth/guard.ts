import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import type { DbClient } from "../db/client.js";
import { readSessionCookie } from "./cookie.js";
import { INTERNAL_RENDER_HEADER, INTERNAL_RENDER_TOKEN } from "./internal-token.js";
import { ensureLocalOwner, getUserBySession } from "./session.js";

/**
 * Resolves request.user for every request. In single-user mode (no OIDC
 * configured) every request is the synthetic local owner and nothing is ever
 * rejected — this is what keeps the rest of the app oblivious to which auth
 * mode it's running in. In OIDC mode, unauthenticated requests to protected
 * /api/* routes get a 401; /api/auth/me is exempt so the frontend can always
 * ask "am I logged in?" without hitting the gate itself.
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

    const sessionId = readSessionCookie(request);
    const user = sessionId ? getUserBySession(db, sessionId) : null;
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
