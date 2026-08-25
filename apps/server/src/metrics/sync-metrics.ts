import { Gauge } from "prom-client";
import { registry } from "./registry.js";

const syncLastScanDurationSeconds = new Gauge({
  name: "model_hub_sync_last_scan_duration_seconds",
  help: "Wall-clock duration of the most recently completed full-library scan (scanLibraryRoot), in seconds.",
  registers: [registry],
});

const syncLastScanTimestampSeconds = new Gauge({
  name: "model_hub_sync_last_scan_timestamp_seconds",
  help: "Unix timestamp (seconds) at which the most recently completed full-library scan finished.",
  registers: [registry],
});

const syncLastScanModelsChangedTotal = new Gauge({
  name: "model_hub_sync_last_scan_models_changed",
  help: "Number of models with a new git commit during the most recently completed full-library scan.",
  registers: [registry],
});

export interface LastScanStats {
  durationSeconds: number;
  timestampSeconds: number;
  modelsChanged: number;
}

// Mirrors the gauges above in a synchronously-readable form — prom-client's
// Gauge.get() is async (a Promise), which is awkward for a plain settings-
// page endpoint that just wants "the last value" without an extra await per
// field. This is the single source of truth recordScanCompleted writes to;
// the gauges are just its Prometheus-facing mirror, not a second computation.
let lastScan: LastScanStats | null = null;

/**
 * Called once per completed (non-skipped) scanLibraryRoot pass — see
 * scanner.ts. Skipped passes (empty LIBRARY_ROOT hiccup, unreadable
 * directory) intentionally leave these gauges untouched, since they didn't
 * represent a real scan.
 */
export function recordScanCompleted(durationSeconds: number, modelsChanged: number): void {
  const timestampSeconds = Date.now() / 1000;
  syncLastScanDurationSeconds.set(durationSeconds);
  syncLastScanTimestampSeconds.set(timestampSeconds);
  syncLastScanModelsChangedTotal.set(modelsChanged);
  lastScan = { durationSeconds, timestampSeconds, modelsChanged };
}

/**
 * The most recently completed full-library scan's stats (same data backing
 * the Prometheus gauges above), or null if no scan has completed yet since
 * this process started. Used by the instance stats page (issue #73) to show
 * sync health without recomputing anything scanner.ts already tracked.
 */
export function getLastScanStats(): LastScanStats | null {
  return lastScan;
}
