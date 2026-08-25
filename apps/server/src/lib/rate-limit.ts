import type { FastifyRequest } from "fastify";
import type { Config } from "../config.js";

/**
 * Per-IP key for unauthenticated routes (login/callback/logout). Uses
 * `request.ip`, which Fastify derives from the raw socket's remote address
 * — never from `X-Forwarded-For` — because this app never sets `trustProxy`
 * (see app.ts/config.ts: no such option exists anywhere in this codebase).
 * If a trusted-reverse-proxy boundary is ever established here, this key
 * should move to whatever Fastify option establishes that trust, not read
 * the header directly; blindly trusting `X-Forwarded-For` today would let
 * any client spoof its rate-limit identity via a plain request header.
 */
export function ipKeyGenerator(request: FastifyRequest): string {
  return request.ip;
}

/**
 * Per-user key for authenticated routes (upload/create). Falls back to
 * per-IP if `request.user` isn't set — defense in depth, not a path this
 * should hit in practice: this key is only ever used with `hook:
 * "preHandler"` (see uploadRateLimit below), and preHandlers always run
 * after the auth guard's onRequest hook (registerAuthGuard, auth/guard.ts)
 * has either set `request.user` (single-user mode: always the synthetic
 * local owner; OIDC mode: a real session/bearer-token user) or already
 * replied 401 and short-circuited the request before any preHandler runs.
 *
 * Note: in single-user mode every request resolves to the same synthetic
 * "local owner" user (see guard.ts), so this key is identical for every
 * caller there — per-user limiting degenerates to a single global limit,
 * same as per-IP would from one LAN. That's expected and not worth
 * special-casing: the config still does something meaningful (bounds total
 * upload rate) and OIDC deployments get the real per-user isolation this
 * was built for.
 */
export function userKeyGenerator(request: FastifyRequest): string {
  return request.user ? `user:${request.user.id}` : `ip:${request.ip}`;
}

export interface RouteRateLimitOptions {
  max: number;
  timeWindow: number;
  keyGenerator: (request: FastifyRequest) => string;
  hook?: "onRequest" | "preHandler";
}

/**
 * Per-IP config for /auth/login, /auth/callback, and /auth/logout — plain
 * `onRequest` (the plugin's default hook) is fine since these don't depend
 * on request.user.
 */
export function authRateLimit(config: Config): RouteRateLimitOptions {
  return {
    max: config.authRateLimitMax,
    timeWindow: config.authRateLimitWindowMs,
    keyGenerator: ipKeyGenerator,
  };
}

/**
 * Per-user config for POST /api/models and POST /api/models/:id/upload.
 * Explicitly runs as a `preHandler`, not the plugin's default `onRequest`
 * — this is what actually guarantees request.user is available by the time
 * userKeyGenerator runs, regardless of plugin/hook *registration* order
 * (Fastify always runs onRequest hooks to completion before any
 * preHandler, for every request), rather than relying on us getting
 * registration order right.
 */
export function uploadRateLimit(config: Config): RouteRateLimitOptions {
  return {
    max: config.uploadRateLimitMax,
    timeWindow: config.uploadRateLimitWindowMs,
    keyGenerator: userKeyGenerator,
    hook: "preHandler",
  };
}
