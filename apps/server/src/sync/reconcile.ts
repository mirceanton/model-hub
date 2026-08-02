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

/** Fixed identity for UI-driven commits (upload, restore) until OIDC (Phase 7) supplies a real user. */
export const LOCAL_UPLOAD_IDENTITY: GitIdentity = {
  name: "model-hub",
  email: "model-hub@localhost",
};

export interface ReconcileResult {
  status: "ok" | "error";
  committed: boolean;
  error?: string;
}

export interface ReconcileOptions {
  /** Identity for the commit created by THIS call, if one is needed. Defaults to the auto-sync identity. */
  identity?: GitIdentity;
  /** Commit message for the commit created by THIS call, if one is needed (ignored for the initial-import commit). */
  commitMessage?: string;
}

type ReconcileInput = Pick<ProjectRow, "id" | "path" | "primaryFilePath">;

/**
 * The single idempotent commit-decision function for a project. Callable from
 * the periodic full-library scan, the debounced watcher, and the upload/restore
 * endpoints — always through the same per-path mutex, so git operations for one
 * project never overlap regardless of trigger.
 */
export function reconcileProject(
  db: DbClient,
  project: ReconcileInput,
  options?: ReconcileOptions,
): Promise<ReconcileResult> {
  return runExclusive(project.path, () => reconcileProjectCore(db, project, options));
}

/**
 * The unlocked core of reconcileProject. Only call this directly if the caller
 * already holds the per-project lock (e.g. the upload endpoint, which must write
 * files and commit them as one atomic sequence under a single lock acquisition —
 * calling the locked reconcileProject from inside an existing lock for the same
 * path would deadlock against itself).
 */
export async function reconcileProjectCore(
  db: DbClient,
  project: ReconcileInput,
  options?: ReconcileOptions,
): Promise<ReconcileResult> {
  const now = new Date();
  const identity = options?.identity ?? AUTO_SYNC_IDENTITY;

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
      const message = !wasGitRepo
        ? "Initial import"
        : (options?.commitMessage ?? generateAutoCommitMessage(status.changedPaths));
      committedSha = await addAllAndCommit(project.path, message, identity);
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
