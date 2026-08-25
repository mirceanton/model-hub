import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { models as modelsTable, type ModelRow } from "../db/schema.js";
import { fetchUrlSafely } from "../lib/safe-fetch.js";
import { sanitizeSnapshotHtml } from "../lib/sanitize-html.js";

export type SnapshotModel = Pick<ModelRow, "id" | "sourceUrl">;

/**
 * Fetches `model.sourceUrl` (through the SSRF-hardened {@link fetchUrlSafely}),
 * sanitizes whatever HTML comes back (see lib/sanitize-html.ts), and stores
 * it as the model's snapshot — or records the failure — leaving
 * `sourceSnapshotStatus` in a terminal state ("ready"/"error"/"none")
 * either way. Mirrors thumbnails/generate.ts's contract: never rejects, so
 * a caller can safely fire-and-forget this via the queue in ./queue.ts.
 *
 * A save with no sourceUrl clears any previously stored snapshot rather
 * than fetching anything — this is the "clearing sourceUrl drops the
 * snapshot" behavior documented on the schema column.
 */
export async function generateSourceSnapshot(db: DbClient, model: SnapshotModel): Promise<void> {
  if (!model.sourceUrl) {
    db.update(modelsTable)
      .set({
        sourceSnapshotStatus: "none",
        sourceSnapshotHtml: null,
        sourceSnapshotError: null,
        sourceSnapshotFetchedAt: null,
      })
      .where(eq(modelsTable.id, model.id))
      .run();
    return;
  }

  const result = await fetchUrlSafely(model.sourceUrl).catch((err: unknown) => ({
    ok: false as const,
    error: err instanceof Error ? err.message : String(err),
  }));

  if (!result.ok || result.body == null) {
    db.update(modelsTable)
      .set({
        sourceSnapshotStatus: "error",
        sourceSnapshotError: result.error ?? "snapshot fetch failed",
        sourceSnapshotFetchedAt: new Date(),
      })
      .where(eq(modelsTable.id, model.id))
      .run();
    return;
  }

  const sanitized = sanitizeSnapshotHtml(result.body);
  db.update(modelsTable)
    .set({
      sourceSnapshotStatus: "ready",
      sourceSnapshotHtml: sanitized,
      sourceSnapshotError: null,
      sourceSnapshotFetchedAt: new Date(),
    })
    .where(eq(modelsTable.id, model.id))
    .run();
}
