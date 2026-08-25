import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { models as modelsTable, type ModelRow } from "../db/schema.js";

/**
 * Looks up a model by id, excluding trashed rows (deletedAt != null) — the
 * lookup every "normal" model route should use (list/detail/edit, file
 * serving, downloads, version history, project pinning, tag mutation,
 * thumbnail regenerate/capture, ...) so a model sitting in
 * LIBRARY_ROOT/.trash/ isn't reachable through them even though its repo is
 * still physically present on disk until purge.
 *
 * Two deliberate exceptions, both unfiltered by design, not oversight:
 * - Routes that specifically operate on trash (api/routes/trash.ts) query
 *   modelsTable directly instead, since they need the opposite filter.
 * - GET /api/models/:id/thumbnail (api/routes/thumbnails.ts) stays
 *   unfiltered because the Trash view itself renders a trashed model's
 *   thumbnail through that same endpoint.
 */
export function getActiveModel(db: DbClient, id: number): ModelRow | undefined {
  return db
    .select()
    .from(modelsTable)
    .where(and(eq(modelsTable.id, id), isNull(modelsTable.deletedAt)))
    .get();
}
