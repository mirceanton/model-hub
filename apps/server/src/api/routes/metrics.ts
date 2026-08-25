import type { FastifyInstance } from "fastify";
import { registry } from "../../metrics/registry.js";

/**
 * Prometheus scrape endpoint. Deliberately unauthenticated, same posture
 * and same mechanism as /healthz (see health.ts): it's registered before
 * registerAuthGuard in app.ts, and its path doesn't start with /api/, so
 * the guard's onRequest hook never 401s it even in OIDC mode (see
 * guard.ts's `isProtectedApiRoute` check). A scrape needs to work without a
 * session or bearer token — if this instance is reachable beyond a trusted
 * network, firewall /metrics off at the network level rather than relying
 * on app-level auth (see CLAUDE.md's Auth section).
 */
export function registerMetricsRoute(app: FastifyInstance): void {
  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
}
