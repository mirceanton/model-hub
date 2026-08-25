import { extname } from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { models as modelsTable, type ModelRow } from "../db/schema.js";
import { MODEL_EXTENSIONS } from "../lib/fs-utils.js";
import { thumbnailJobsCompletedTotal, thumbnailJobsFailedTotal } from "../metrics/thumbnail-metrics.js";
import type { ReconcileResult } from "../sync/reconcile.js";
import { generateThumbnail, type ThumbnailContext } from "./generate.js";
import { ThumbnailQueue } from "./queue.js";

let queue: ThumbnailQueue | null = null;
let context: ThumbnailContext | null = null;

/** Must be called once at boot before any enqueue calls (scanner/watcher/upload routes are no-ops otherwise, e.g. under test). */
export function initThumbnailPipeline(concurrency: number, webBaseUrl: string): void {
  queue = new ThumbnailQueue(concurrency);
  context = { webBaseUrl };
}

function isViewablePrimaryFile(primaryFilePath: string | null | undefined): boolean {
  if (!primaryFilePath) return false;
  return MODEL_EXTENSIONS.has(extname(primaryFilePath).slice(1).toLowerCase());
}

type ThumbnailModel = Pick<ModelRow, "id" | "path" | "primaryFilePath">;

export function enqueueThumbnail(db: DbClient, model: ThumbnailModel): void {
  if (!queue || !context) return;
  if (!isViewablePrimaryFile(model.primaryFilePath)) return;
  const ctx = context;
  queue.enqueue(() =>
    generateThumbnail(db, model, ctx).then((outcome) => {
      if (outcome === "ready") {
        thumbnailJobsCompletedTotal.inc();
      } else {
        thumbnailJobsFailedTotal.inc();
      }
    }),
  );
}

/**
 * Enqueues a thumbnail render only when the reconcile actually produced a new
 * commit (content changed) AND the model's current thumbnail isn't a
 * user-captured one — "manual" is sticky against this auto-regeneration path
 * so a routine file upload/restore doesn't silently overwrite a deliberately
 * posed shot. The explicit regenerate endpoint bypasses this by resetting
 * thumbnailSource back to "auto" itself before calling enqueueThumbnail directly.
 */
export function maybeEnqueueThumbnail(
  db: DbClient,
  model: ThumbnailModel & Pick<ModelRow, "thumbnailSource">,
  result: ReconcileResult,
): void {
  if (result.status === "ok" && result.committed && model.thumbnailSource !== "manual") {
    enqueueThumbnail(db, { ...model, primaryFilePath: result.primaryFilePath ?? null });
  }
}

/**
 * Boot-time recovery: requeues thumbnails left mid-flight by a crash
 * ("generating" never reached a terminal state) and any never attempted
 * ("pending", e.g. from a version of the app installed before this phase).
 */
export function sweepPendingThumbnails(db: DbClient): void {
  const stale = db
    .select()
    .from(modelsTable)
    .where(
      and(
        inArray(modelsTable.thumbnailStatus, ["pending", "generating"]),
        isNull(modelsTable.deletedAt),
      ),
    )
    .all();

  for (const model of stale) {
    if (model.thumbnailStatus === "generating") {
      db.update(modelsTable)
        .set({ thumbnailStatus: "pending" })
        .where(eq(modelsTable.id, model.id))
        .run();
    }
    enqueueThumbnail(db, model);
  }
}
