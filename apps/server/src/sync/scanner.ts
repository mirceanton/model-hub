import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { models as modelsTable, type ModelRow } from "../db/schema.js";
import { ensureMarkerId, TRASH_DIRNAME } from "../lib/fs-utils.js";
import { recordPinDropNotices } from "../lib/project-notices.js";
import { recordScanCompleted } from "../metrics/sync-metrics.js";
import { maybeEnqueueThumbnail } from "../thumbnails/trigger.js";
import { runExclusive } from "./queue.js";
import { reconcileModel } from "./reconcile.js";

export interface ScanResult {
  scanned: number;
  skipped: boolean;
  reason?: string;
}

async function listTopLevelDirNames(libraryRoot: string): Promise<string[]> {
  const entries = await readdir(libraryRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== TRASH_DIRNAME)
    .map((entry) => entry.name);
}

/**
 * Full-library reconciliation pass: discovers model directories one level
 * deep under `libraryRoot`, resolves each to a stable DB row via its
 * `.modelhub-id` marker (surviving renames), marks vanished models as
 * missing without deleting their metadata, then reconciles every present
 * model's git/files state.
 */
export async function scanLibraryRoot(db: DbClient, libraryRoot: string): Promise<ScanResult> {
  const startedAtMs = Date.now();
  let dirNames: string[];
  try {
    dirNames = await listTopLevelDirNames(libraryRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { scanned: 0, skipped: true, reason: `Cannot read LIBRARY_ROOT: ${message}` };
  }

  // Trashed rows are entirely out of scope for this pass: their directories
  // live under .trash/ (already excluded from dirNames above), and they must
  // never get flipped to "missing" just because a normal top-level scan
  // naturally can't find them at their old path — see purgeExpiredTrash below
  // for what actually happens to them.
  const existingModels = db.select().from(modelsTable).where(isNull(modelsTable.deletedAt)).all();
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

  let changed = 0;
  for (const row of presentRows) {
    const result = await reconcileModel(db, row);
    if (result.status === "ok" && result.committed) changed += 1;
    maybeEnqueueThumbnail(db, row, result);
  }

  recordScanCompleted((Date.now() - startedAtMs) / 1000, changed);

  return { scanned: presentRows.length, skipped: false };
}

export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface PurgeResult {
  purged: number;
}

/**
 * Permanently removes anything in .trash/ older than TRASH_RETENTION_MS:
 * deletes the on-disk directory and hard-deletes the DB row (cascading, via
 * FK, to its files/tags/project pins — same as the old immediate-delete
 * behavior). Called on the same periodic tick as scanLibraryRoot (see
 * index.ts) rather than its own interval, since trash bookkeeping is just
 * another pass over the same LIBRARY_ROOT, not a separate subsystem.
 *
 * Re-checks deletedAt (and re-reads path) from the DB *inside* the per-path
 * lock before touching anything: a manual restore or manual purge triggered
 * from the Trash view (api/routes/trash.ts) locks on this same row's current
 * path, so if one of those wins the race for a given row, this loop's stale
 * copy of that row must not blindly rm+delete out from under it.
 */
export async function purgeExpiredTrash(db: DbClient): Promise<PurgeResult> {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_MS);
  const expired = db
    .select()
    .from(modelsTable)
    .where(and(isNotNull(modelsTable.deletedAt), lt(modelsTable.deletedAt, cutoff)))
    .all();

  let purged = 0;
  for (const row of expired) {
    const didPurge = await runExclusive(row.path, async () => {
      const fresh = db.select().from(modelsTable).where(eq(modelsTable.id, row.id)).get();
      if (!fresh || fresh.deletedAt == null) return false;
      await rm(fresh.path, { recursive: true, force: true });
      // Same ordering requirement as trash.ts's permanent-delete route: must
      // run before the cascade-triggering delete below.
      recordPinDropNotices(db, fresh.id, fresh.title);
      db.delete(modelsTable).where(eq(modelsTable.id, row.id)).run();
      return true;
    });
    if (didPurge) purged++;
  }

  return { purged };
}
