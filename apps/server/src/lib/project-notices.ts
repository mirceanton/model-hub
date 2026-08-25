import type { ProjectActivityNotice } from "@model-hub/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import {
  projectActivity as projectActivityTable,
  projectModelPins as projectModelPinsTable,
  type ProjectActivityRow,
} from "../db/schema.js";

/**
 * Records a "this pinned model was removed from the library" notice on every
 * project that still has a pin on `modelId`, at the moment.
 *
 * TIMING (deliberate design call, see CLAUDE.md's Projects section and issue
 * #69): this must be called at the point a model's DB row is *actually*
 * hard-deleted — permanent-delete-from-trash (api/routes/trash.ts) or the
 * 7-day auto-purge (sync/scanner.ts's purgeExpiredTrash) — and it must be
 * called BEFORE the `DELETE FROM models` that triggers
 * `ON DELETE CASCADE` on project_model_pins, since that cascade removes the
 * pin rows this function reads to find "which projects are affected." It is
 * deliberately NOT called at the initial soft-delete (moving a model to
 * .trash/): a trashed model's pin still points at a valid commit of a repo
 * that still exists on disk, and if the model is restored within the 7-day
 * window the pin is completely unaffected — nothing actually happened to the
 * project yet. Firing a notice at soft-delete time would be a false alarm on
 * that (very common) restore path. The notice only fires once the pin is
 * genuinely, irreversibly gone.
 *
 * Caller supplies `modelTitle` explicitly (rather than this function joining
 * on the model row) because by the time this runs the model row is either
 * already gone or is about to be deleted in the very next statement — there
 * may be nothing left to join against.
 */
export function recordPinDropNotices(db: DbClient, modelId: number, modelTitle: string): void {
  const affected = db
    .select({ projectId: projectModelPinsTable.projectId })
    .from(projectModelPinsTable)
    .where(eq(projectModelPinsTable.modelId, modelId))
    .all();
  if (affected.length === 0) return;

  const now = new Date();
  const message = `Model "${modelTitle}" was removed from this project because it was deleted from the library.`;
  for (const { projectId } of affected) {
    db.insert(projectActivityTable)
      .values({ projectId, message, createdAt: now })
      .run();
  }
}

function toNotice(row: ProjectActivityRow): ProjectActivityNotice {
  return {
    id: row.id,
    message: row.message,
    createdAt: row.createdAt.getTime(),
  };
}

/** Non-dismissed notices for a project, oldest first — used by GET /api/projects/:id. */
export function getActiveNoticesForProject(db: DbClient, projectId: number): ProjectActivityNotice[] {
  const rows = db
    .select()
    .from(projectActivityTable)
    .where(and(eq(projectActivityTable.projectId, projectId), isNull(projectActivityTable.dismissedAt)))
    .all();
  return rows.map(toNotice).sort((a, b) => a.createdAt - b.createdAt);
}

/** Soft-dismiss: keeps the row (per CLAUDE.md-style "no data loss on dismiss"), just stamps dismissedAt. Returns false if no matching, still-active notice exists. */
export function dismissNotice(db: DbClient, projectId: number, noticeId: number): boolean {
  const updated = db
    .update(projectActivityTable)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(projectActivityTable.id, noticeId),
        eq(projectActivityTable.projectId, projectId),
        isNull(projectActivityTable.dismissedAt),
      ),
    )
    .returning()
    .get();
  return updated != null;
}
