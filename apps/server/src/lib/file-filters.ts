import { sql } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { files as filesTable } from "../db/schema.js";

/**
 * Returns the IDs of models that have at least one tracked file (model file
 * *or* attachment — both live in the same `files` table, see schema.ts and
 * api/routes/models.ts's `files`/`attachments` split) whose extension
 * matches, case-insensitively and without a leading dot (e.g. "obj", "pdf").
 * Deliberately not restricted to model-only extensions: "models with a PDF
 * instruction sheet" is a plausible filter now that attachments exist (see
 * lib/fs-utils.ts's MODEL_EXTENSIONS vs ATTACHMENT_EXTENSIONS).
 */
export function getModelIdsWithExtension(db: DbClient, extension: string): Set<number> {
  const ext = extension.trim().toLowerCase();
  if (!ext) return new Set();

  const rows = db
    .select({ modelId: filesTable.modelId })
    .from(filesTable)
    .where(sql`lower(${filesTable.extension}) = ${ext}`)
    .all();
  return new Set(rows.map((r) => r.modelId));
}

export interface ModelFileAggregate {
  totalSizeBytes: number;
  fileCount: number;
}

/**
 * Per-model total file size and file count, summed across every tracked file
 * (model files + attachments, same "all files" scope as
 * getModelIdsWithExtension above). A model with no rows in `files` at all
 * (e.g. still mid-sync) simply has no entry here — callers should treat a
 * missing entry as {totalSizeBytes: 0, fileCount: 0}, not "unknown."
 *
 * Re-scans the whole `files` table on every call rather than maintaining a
 * running per-model total — same simplest-thing-that-works tradeoff as
 * lib/duplicates.ts's computeDuplicateModelMap, at the same self-hosted-
 * library scale.
 */
export function getModelFileAggregates(db: DbClient): Map<number, ModelFileAggregate> {
  const rows = db
    .select({
      modelId: filesTable.modelId,
      totalSizeBytes: sql<number>`sum(${filesTable.sizeBytes})`,
      fileCount: sql<number>`count(*)`,
    })
    .from(filesTable)
    .groupBy(filesTable.modelId)
    .all();

  const result = new Map<number, ModelFileAggregate>();
  for (const row of rows) {
    result.set(row.modelId, {
      totalSizeBytes: Number(row.totalSizeBytes),
      fileCount: Number(row.fileCount),
    });
  }
  return result;
}
