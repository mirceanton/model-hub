import type { FastifyInstance } from "fastify";
import { Counter, Histogram } from "prom-client";
import { registry } from "./registry.js";

const LABEL_NAMES = ["method", "route", "status"] as const;

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled, labeled by method, matched route pattern, and status code.",
  labelNames: LABEL_NAMES,
  registers: [registry],
});

const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, labeled by method, matched route pattern, and status code.",
  labelNames: LABEL_NAMES,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Registered as the very first thing in buildApp (see app.ts) so its
 * onResponse hook wraps every route, including ones registered later.
 *
 * Labels by `request.routeOptions.url` — the matched route *pattern* (e.g.
 * "/api/models/:id") — never `request.url`, which contains real IDs and
 * would give every distinct request its own label combination (unbounded
 * cardinality, and a trivial way for a scanner hitting random paths to
 * blow up memory in the metrics registry). Requests that never matched a
 * route (404s, `request.routeOptions.url` is undefined) are labeled
 * "unmatched" for the same reason.
 */
export function registerHttpMetrics(app: FastifyInstance): void {
  app.addHook("onResponse", async (request, reply) => {
    const labels = {
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, reply.elapsedTime / 1000);
  });
}
