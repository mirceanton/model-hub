import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { files as filesTable, models as modelsTable } from "../db/schema.js";

export interface DuplicateModelRef {
  modelId: number;
  modelTitle: string;
}

/**
 * Maps every active model id that has at least one possible duplicate to the
 * other active models it shares an identical-content file with (matched via
 * files.contentHash — see sync/reconcile.ts for where that gets populated).
 *
 * Trashed models are excluded on both sides of the comparison — a trashed
 * model sharing a hash with a live one isn't useful signal since it's about
 * to be purged (see CLAUDE.md's trash/recycle bin section), matching
 * lib/model-lookup.ts's getActiveModel filtering used elsewhere.
 *
 * This re-scans all active files' hashes on every call rather than
 * maintaining a running index — simplest thing that works for a self-hosted
 * library's scale; revisit if it ever shows up in profiling.
 */
export function computeDuplicateModelMap(db: DbClient): Map<number, DuplicateModelRef[]> {
  const rows = db
    .select({
      modelId: filesTable.modelId,
      contentHash: filesTable.contentHash,
      modelTitle: modelsTable.title,
    })
    .from(filesTable)
    .innerJoin(modelsTable, eq(filesTable.modelId, modelsTable.id))
    .where(and(isNull(modelsTable.deletedAt), isNotNull(filesTable.contentHash)))
    .all();

  const modelsByHash = new Map<string, Map<number, string>>();
  for (const row of rows) {
    if (!row.contentHash) continue;
    let modelsForHash = modelsByHash.get(row.contentHash);
    if (!modelsForHash) {
      modelsForHash = new Map();
      modelsByHash.set(row.contentHash, modelsForHash);
    }
    modelsForHash.set(row.modelId, row.modelTitle);
  }

  const duplicatesByModel = new Map<number, Map<number, string>>();
  for (const modelsForHash of modelsByHash.values()) {
    if (modelsForHash.size < 2) continue; // Unique to one model — not a duplicate.
    for (const [modelId] of modelsForHash) {
      let existing = duplicatesByModel.get(modelId);
      if (!existing) {
        existing = new Map();
        duplicatesByModel.set(modelId, existing);
      }
      for (const [otherId, otherTitle] of modelsForHash) {
        if (otherId !== modelId) existing.set(otherId, otherTitle);
      }
    }
  }

  const result = new Map<number, DuplicateModelRef[]>();
  for (const [modelId, others] of duplicatesByModel) {
    result.set(
      modelId,
      Array.from(others, ([otherId, otherTitle]) => ({ modelId: otherId, modelTitle: otherTitle })).sort(
        (a, b) => a.modelId - b.modelId,
      ),
    );
  }
  return result;
}

/** Convenience single-model lookup built on top of computeDuplicateModelMap. */
export function getDuplicateModels(db: DbClient, modelId: number): DuplicateModelRef[] {
  return computeDuplicateModelMap(db).get(modelId) ?? [];
}
