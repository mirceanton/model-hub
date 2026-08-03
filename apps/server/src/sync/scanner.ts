import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { models as modelsTable, type ModelRow } from "../db/schema.js";
import { ensureMarkerId } from "../lib/fs-utils.js";
import { maybeEnqueueThumbnail } from "../thumbnails/trigger.js";
import { reconcileModel } from "./reconcile.js";

export interface ScanResult {
  scanned: number;
  skipped: boolean;
  reason?: string;
}

async function listTopLevelDirNames(libraryRoot: string): Promise<string[]> {
  const entries = await readdir(libraryRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * Full-library reconciliation pass: discovers model directories one level
 * deep under `libraryRoot`, resolves each to a stable DB row via its
 * `.modelhub-id` marker (surviving renames), marks vanished models as
 * missing without deleting their metadata, then reconciles every present
 * model's git/files state.
 */
export async function scanLibraryRoot(db: DbClient, libraryRoot: string): Promise<ScanResult> {
  let dirNames: string[];
  try {
    dirNames = await listTopLevelDirNames(libraryRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { scanned: 0, skipped: true, reason: `Cannot read LIBRARY_ROOT: ${message}` };
  }

  const existingModels = db.select().from(modelsTable).all();
  const knownPresentCount = existingModels.filter((m) => m.missingSince == null).length;

  // A network mount hiccup can make LIBRARY_ROOT briefly look empty; never let
  // that mass-mark every known model as missing.
  if (dirNames.length === 0 && knownPresentCount > 0) {
    return {
      scanned: 0,
      skipped: true,
      reason: `LIBRARY_ROOT listed 0 directories but ${knownPresentCount} known model(s) exist; skipping this pass`,
    };
  }

  const now = new Date();
  const presentFsIds = new Set<string>();
  const presentRows: ModelRow[] = [];

  for (const dirName of dirNames) {
    const modelPath = join(libraryRoot, dirName);
    const info = await stat(modelPath).catch(() => null);
    if (!info?.isDirectory()) continue;

    const { id: fsId } = await ensureMarkerId(modelPath);
    presentFsIds.add(fsId);

    const existing = existingModels.find((m) => m.fsId === fsId);
    if (existing) {
      if (existing.path !== modelPath || existing.missingSince != null) {
        db.update(modelsTable)
          .set({ path: modelPath, missingSince: null, updatedAt: now })
          .where(eq(modelsTable.id, existing.id))
          .run();
      }
      presentRows.push({ ...existing, path: modelPath, missingSince: null });
      continue;
    }

    const inserted = db
      .insert(modelsTable)
      .values({
        fsId,
        path: modelPath,
        title: dirName,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    presentRows.push(inserted);
  }

  const missingRows = existingModels.filter(
    (m) => !presentFsIds.has(m.fsId) && m.missingSince == null,
  );
  for (const row of missingRows) {
    db.update(modelsTable)
      .set({ missingSince: now, syncStatus: "missing", updatedAt: now })
      .where(eq(modelsTable.id, row.id))
      .run();
  }

  for (const row of presentRows) {
    const result = await reconcileModel(db, row);
    maybeEnqueueThumbnail(db, row, result);
  }

  return { scanned: presentRows.length, skipped: false };
}
