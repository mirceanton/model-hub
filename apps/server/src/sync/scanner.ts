import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { projects as projectsTable, type ProjectRow } from "../db/schema.js";
import { ensureMarkerId } from "../lib/fs-utils.js";
import { reconcileProject } from "./reconcile.js";

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
 * Full-library reconciliation pass: discovers project directories one level
 * deep under `libraryRoot`, resolves each to a stable DB row via its
 * `.modelhub-id` marker (surviving renames), marks vanished projects as
 * missing without deleting their metadata, then reconciles every present
 * project's git/files state.
 */
export async function scanLibraryRoot(db: DbClient, libraryRoot: string): Promise<ScanResult> {
  let dirNames: string[];
  try {
    dirNames = await listTopLevelDirNames(libraryRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { scanned: 0, skipped: true, reason: `Cannot read LIBRARY_ROOT: ${message}` };
  }

  const existingProjects = db.select().from(projectsTable).all();
  const knownPresentCount = existingProjects.filter((p) => p.missingSince == null).length;

  // A network mount hiccup can make LIBRARY_ROOT briefly look empty; never let
  // that mass-mark every known project as missing.
  if (dirNames.length === 0 && knownPresentCount > 0) {
    return {
      scanned: 0,
      skipped: true,
      reason: `LIBRARY_ROOT listed 0 directories but ${knownPresentCount} known project(s) exist; skipping this pass`,
    };
  }

  const now = new Date();
  const presentFsIds = new Set<string>();
  const presentRows: ProjectRow[] = [];

  for (const dirName of dirNames) {
    const projectPath = join(libraryRoot, dirName);
    const info = await stat(projectPath).catch(() => null);
    if (!info?.isDirectory()) continue;

    const { id: fsId } = await ensureMarkerId(projectPath);
    presentFsIds.add(fsId);

    const existing = existingProjects.find((p) => p.fsId === fsId);
    if (existing) {
      if (existing.path !== projectPath || existing.missingSince != null) {
        db.update(projectsTable)
          .set({ path: projectPath, missingSince: null, updatedAt: now })
          .where(eq(projectsTable.id, existing.id))
          .run();
      }
      presentRows.push({ ...existing, path: projectPath, missingSince: null });
      continue;
    }

    const inserted = db
      .insert(projectsTable)
      .values({
        fsId,
        path: projectPath,
        title: dirName,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    presentRows.push(inserted);
  }

  const missingRows = existingProjects.filter(
    (p) => !presentFsIds.has(p.fsId) && p.missingSince == null,
  );
  for (const row of missingRows) {
    db.update(projectsTable)
      .set({ missingSince: now, syncStatus: "missing", updatedAt: now })
      .where(eq(projectsTable.id, row.id))
      .run();
  }

  for (const row of presentRows) {
    await reconcileProject(db, row);
  }

  return { scanned: presentRows.length, skipped: false };
}
