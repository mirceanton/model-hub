import { Registry, collectDefaultMetrics } from "prom-client";

/**
 * Single process-wide registry every custom metric below registers
 * against, plus prom-client's default Node.js/process metrics (event loop
 * lag, memory, GC, handles) — collecting those is a one-line call and
 * standard practice for a /metrics endpoint, unlike the queue/scan/http
 * metrics which are hand-rolled to match this app's specific concerns (see
 * CLAUDE.md's Thumbnails/Sync sections).
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });
