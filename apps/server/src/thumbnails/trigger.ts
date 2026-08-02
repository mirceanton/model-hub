import { extname } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { projects as projectsTable, type ProjectRow } from "../db/schema.js";
import { MODEL_EXTENSIONS } from "../lib/fs-utils.js";
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

type ThumbnailProject = Pick<ProjectRow, "id" | "path" | "primaryFilePath">;

export function enqueueThumbnail(db: DbClient, project: ThumbnailProject): void {
  if (!queue || !context) return;
  if (!isViewablePrimaryFile(project.primaryFilePath)) return;
  const ctx = context;
  queue.enqueue(() => generateThumbnail(db, project, ctx));
}

/** Enqueues a thumbnail render only when the reconcile actually produced a new commit — i.e. content changed. */
export function maybeEnqueueThumbnail(
  db: DbClient,
  project: ThumbnailProject,
  result: ReconcileResult,
): void {
  if (result.status === "ok" && result.committed) {
    enqueueThumbnail(db, { ...project, primaryFilePath: result.primaryFilePath ?? null });
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
    .from(projectsTable)
    .where(inArray(projectsTable.thumbnailStatus, ["pending", "generating"]))
    .all();

  for (const project of stale) {
    if (project.thumbnailStatus === "generating") {
      db.update(projectsTable)
        .set({ thumbnailStatus: "pending" })
        .where(eq(projectsTable.id, project.id))
        .run();
    }
    enqueueThumbnail(db, project);
  }
}
