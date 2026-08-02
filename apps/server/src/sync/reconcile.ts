import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { files as filesTable, projects as projectsTable, type ProjectRow } from "../db/schema.js";
import { ensureGitignore, ensureMarkerId, listProjectFiles, pickPrimaryFile } from "../lib/fs-utils.js";
import { generateAutoCommitMessage } from "./commit-message.js";
import {
  addAllAndCommit,
  clearStaleLock,
  getStatus,
  type GitIdentity,
  initRepo,
  isGitRepo,
} from "./git.js";
import { runExclusive } from "./queue.js";

export const AUTO_SYNC_IDENTITY: GitIdentity = {
  name: "model-hub (auto-sync)",
  email: "sync@model-hub.local",
};

export interface ReconcileResult {
  status: "ok" | "error";
  committed: boolean;
  error?: string;
}

type ReconcileInput = Pick<ProjectRow, "id" | "path" | "primaryFilePath">;

/**
 * The single idempotent commit-decision function for a project. Callable from
 * the periodic full-library scan, the debounced watcher, and (in later
 * phases) the upload endpoint — always through the same per-path mutex, so
 * git operations for one project never overlap regardless of trigger.
 */
export function reconcileProject(db: DbClient, project: ReconcileInput): Promise<ReconcileResult> {
  return runExclusive(project.path, () => reconcileProjectInner(db, project));
}

async function reconcileProjectInner(
  db: DbClient,
  project: ReconcileInput,
): Promise<ReconcileResult> {
  const now = new Date();

  try {
    await ensureMarkerId(project.path);
    await ensureGitignore(project.path);

    const wasGitRepo = await isGitRepo(project.path);
    if (!wasGitRepo) {
      await initRepo(project.path);
    } else {
      await clearStaleLock(project.path);
    }

    const status = await getStatus(project.path);
    let committedSha: string | null = null;
    if (!status.isClean) {
      const message = wasGitRepo ? generateAutoCommitMessage(status.changedPaths) : "Initial import";
      committedSha = await addAllAndCommit(project.path, message, AUTO_SYNC_IDENTITY);
    }

    const fileEntries = await listProjectFiles(project.path);
    const stillValidPrimary =
      project.primaryFilePath != null &&
      fileEntries.some((f) => f.relativePath === project.primaryFilePath);
    const primaryFilePath = stillValidPrimary ? project.primaryFilePath : pickPrimaryFile(fileEntries);

    db.transaction((tx) => {
      tx.delete(filesTable).where(eq(filesTable.projectId, project.id)).run();
      if (fileEntries.length > 0) {
        tx.insert(filesTable)
          .values(
            fileEntries.map((f) => ({
              projectId: project.id,
              relativePath: f.relativePath,
              sizeBytes: f.sizeBytes,
              mtime: new Date(f.mtime),
              extension: f.extension,
            })),
          )
          .run();
      }

      tx.update(projectsTable)
        .set({
          primaryFilePath,
          ...(committedSha != null ? { lastSyncedCommitSha: committedSha } : {}),
          lastSyncedAt: now,
          syncStatus: "ok",
          syncError: null,
          missingSince: null,
          updatedAt: now,
        })
        .where(eq(projectsTable.id, project.id))
        .run();
    });

    return { status: "ok", committed: committedSha != null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.update(projectsTable)
      .set({ syncStatus: "error", syncError: message, updatedAt: now })
      .where(eq(projectsTable.id, project.id))
      .run();
    return { status: "error", committed: false, error: message };
  }
}
