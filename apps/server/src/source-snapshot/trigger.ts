import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { models as modelsTable } from "../db/schema.js";
import { generateSourceSnapshot, type SnapshotModel } from "./generate.js";
import { SourceSnapshotQueue } from "./queue.js";

let queue: SourceSnapshotQueue | null = null;

// Plain HTTP fetches, not headless-browser renders, so this can afford more
// concurrency than THUMBNAIL_CONCURRENCY without a dedicated env var.
const DEFAULT_CONCURRENCY = 3;

/**
 * Must be called once at boot before any enqueue calls (route handlers are
 * no-ops otherwise, e.g. under test that only registers routes directly).
 * Unlike the thumbnail pipeline, this has no dependency on this server's own
 * `app.listen()` having bound yet — it only ever fetches *other* servers.
 */
export function initSourceSnapshotPipeline(concurrency: number = DEFAULT_CONCURRENCY): void {
  queue = new SourceSnapshotQueue(concurrency);
}

export function enqueueSourceSnapshot(db: DbClient, model: SnapshotModel): void {
  if (!queue) return;
  queue.enqueue(() => generateSourceSnapshot(db, model));
}

/**
 * Boot-time recovery: requeues snapshot fetches left mid-flight by a crash
 * ("pending" never reached a terminal state) — same shape as
 * thumbnails/trigger.ts's sweepPendingThumbnails.
 */
export function sweepPendingSourceSnapshots(db: DbClient): void {
  const stale = db
    .select({ id: modelsTable.id, sourceUrl: modelsTable.sourceUrl })
    .from(modelsTable)
    .where(and(eq(modelsTable.sourceSnapshotStatus, "pending"), isNull(modelsTable.deletedAt)))
    .all();

  for (const model of stale) {
    enqueueSourceSnapshot(db, model);
  }
}
