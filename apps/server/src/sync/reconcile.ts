import { stat } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { files as filesTable, models as modelsTable, type ModelRow } from "../db/schema.js";
import { ensureGitignore, ensureMarkerId, listModelFiles, pickPrimaryFile } from "../lib/fs-utils.js";
import { generateAutoCommitMessage } from "./commit-message.js";
import {
  addAllAndCommit,
  clearStaleLock,
  getHeadSha,
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
  /** The model's primaryFilePath after this reconcile, so callers (e.g. the thumbnail trigger) don't need a re-fetch. Undefined on error. */
  primaryFilePath?: string | null;
  error?: string;
}

export interface ReconcileOptions {
  /** Identity for the commit created by THIS call, if one is needed. Defaults to the auto-sync identity. */
  identity?: GitIdentity;
  /** Commit message for the commit created by THIS call, if one is needed (ignored for the initial-import commit). */
  commitMessage?: string;
}

type ReconcileInput = Pick<ModelRow, "id" | "path" | "primaryFilePath" | "lastSyncedCommitSha">;

/**
 * The single idempotent commit-decision function for a model. Callable from
 * the periodic full-library scan, the debounced watcher, and the upload/restore
 * endpoints — always through the same per-path mutex, so git operations for one
 * model never overlap regardless of trigger.
 */
export function reconcileModel(
  db: DbClient,
  model: ReconcileInput,
  options?: ReconcileOptions,
): Promise<ReconcileResult> {
  return runExclusive(model.path, () => reconcileModelCore(db, model, options));
}

/**
 * The unlocked core of reconcileModel. Only call this directly if the caller
 * already holds the per-model lock (e.g. the upload endpoint, which must write
 * files and commit them as one atomic sequence under a single lock acquisition —
 * calling the locked reconcileModel from inside an existing lock for the same
 * path would deadlock against itself).
 */
export async function reconcileModelCore(
  db: DbClient,
  model: ReconcileInput,
  options?: ReconcileOptions,
): Promise<ReconcileResult> {
  const now = new Date();
  const identity = options?.identity ?? AUTO_SYNC_IDENTITY;

  try {
    await ensureMarkerId(model.path);
    await ensureGitignore(model.path);

    const wasGitRepo = await isGitRepo(model.path);
    if (!wasGitRepo) {
      await initRepo(model.path);
    } else {
      await clearStaleLock(model.path);
    }

    const status = await getStatus(model.path);
    let committedSha: string | null = null;
    if (!status.isClean) {
      const message = !wasGitRepo
        ? "Initial import"
        : (options?.commitMessage ?? generateAutoCommitMessage(status.changedPaths));
      committedSha = await addAllAndCommit(model.path, message, identity);
    }

    // When the repo is clean but lastSyncedCommitSha was never populated (e.g.
    // the repo pre-existed with commits before model-hub started tracking it,
    // or an earlier bug left it as an empty string), read HEAD so pin-target
    // resolution has something to work with. Falsy, not just `== null`: an
    // empty-string sha is never a valid commit reference either.
    let headSha: string | null = null;
    if (!committedSha && !model.lastSyncedCommitSha) {
      headSha = await getHeadSha(model.path);
    }

    const fileEntries = await listModelFiles(model.path);
    const stillValidPrimary =
      model.primaryFilePath != null &&
      fileEntries.some((f) => f.relativePath === model.primaryFilePath);
    const primaryFilePath = stillValidPrimary ? model.primaryFilePath : pickPrimaryFile(fileEntries);

    db.transaction((tx) => {
      tx.delete(filesTable).where(eq(filesTable.modelId, model.id)).run();
      if (fileEntries.length > 0) {
        tx.insert(filesTable)
          .values(
            fileEntries.map((f) => ({
              modelId: model.id,
              relativePath: f.relativePath,
              sizeBytes: f.sizeBytes,
              mtime: new Date(f.mtime),
              extension: f.extension,
            })),
          )
          .run();
      }

      const resolvedSha = committedSha || headSha;
      tx.update(modelsTable)
        .set({
          primaryFilePath,
          ...(resolvedSha ? { lastSyncedCommitSha: resolvedSha } : {}),
          lastSyncedAt: now,
          syncStatus: "ok",
          syncError: null,
          missingSince: null,
          updatedAt: now,
        })
        .where(eq(modelsTable.id, model.id))
        .run();
    });

    return { status: "ok", committed: committedSha != null, primaryFilePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // A watcher-triggered (or otherwise stale) reconcile can still be in
    // flight after the directory has already vanished — e.g. the periodic
    // scan already correctly marked this model "missing" moments earlier.
    // Whatever operation actually threw (ensureMarkerId, git init, ...),
    // if the directory itself is gone that's the real story, not some
    // arbitrary ENOENT — don't clobber a correct "missing" with a
    // confusing "error".
    const directoryExists = await stat(model.path)
      .then(() => true)
      .catch(() => false);

    if (!directoryExists) {
      db.update(modelsTable)
        .set({ syncStatus: "missing", syncError: null, missingSince: now, updatedAt: now })
        .where(eq(modelsTable.id, model.id))
        .run();
      return { status: "error", committed: false, error: "directory no longer exists" };
    }

    db.update(modelsTable)
      .set({ syncStatus: "error", syncError: message, updatedAt: now })
      .where(eq(modelsTable.id, model.id))
      .run();
    return { status: "error", committed: false, error: message };
  }
}
