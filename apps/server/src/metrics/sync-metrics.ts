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

/**
 * Called once per completed (non-skipped) scanLibraryRoot pass — see
 * scanner.ts. Skipped passes (empty LIBRARY_ROOT hiccup, unreadable
 * directory) intentionally leave these gauges untouched, since they didn't
 * represent a real scan.
 */
export function recordScanCompleted(durationSeconds: number, modelsChanged: number): void {
  syncLastScanDurationSeconds.set(durationSeconds);
  syncLastScanTimestampSeconds.set(Date.now() / 1000);
  syncLastScanModelsChangedTotal.set(modelsChanged);
}
