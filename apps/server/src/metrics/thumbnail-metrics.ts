import { Counter, Gauge } from "prom-client";
import { registry } from "./registry.js";

/**
 * Queue depth/in-flight are gauges updated directly by ThumbnailQueue
 * (queue.ts) as jobs move through it — it's the only place that owns
 * `pending`/`active`, so it sets these rather than exposing internals for
 * something else to poll. Completed/failed are counters incremented by the
 * job's own outcome (see generate.ts's return value and trigger.ts's
 * wrapper), since generateThumbnail deliberately never rejects — a
 * try/catch around job() in the queue would never see a failure.
 */
export const thumbnailQueueDepth = new Gauge({
  name: "model_hub_thumbnail_queue_depth",
  help: "Number of thumbnail jobs waiting to run (queued but not yet started; excludes in-flight jobs).",
  registers: [registry],
});

export const thumbnailQueueInFlight = new Gauge({
  name: "model_hub_thumbnail_queue_in_flight",
  help: "Number of thumbnail jobs currently rendering.",
  registers: [registry],
});

export const thumbnailJobsCompletedTotal = new Counter({
  name: "model_hub_thumbnail_jobs_completed_total",
  help: "Total thumbnail jobs that finished successfully (thumbnailStatus became 'ready').",
  registers: [registry],
});

export const thumbnailJobsFailedTotal = new Counter({
  name: "model_hub_thumbnail_jobs_failed_total",
  help: "Total thumbnail jobs that finished with an error (thumbnailStatus became 'error').",
  registers: [registry],
});
