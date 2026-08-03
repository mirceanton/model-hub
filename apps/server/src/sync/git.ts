import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { GitLogEntry } from "@model-hub/shared";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitStatusSummary {
  isClean: boolean;
  changedPaths: string[];
}

const STALE_LOCK_THRESHOLD_MS = 60_000;

function clientFor(modelDir: string, identity?: GitIdentity): SimpleGit {
  return simpleGit({
    baseDir: modelDir,
    config: identity ? [`user.name=${identity.name}`, `user.email=${identity.email}`] : [],
  });
}

export async function isGitRepo(modelDir: string): Promise<boolean> {
  try {
    const info = await stat(join(modelDir, ".git"));
    return info.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function initRepo(modelDir: string): Promise<void> {
  await clientFor(modelDir).init(false);
}

/**
 * A crash mid-commit can leave `.git/index.lock` behind, permanently wedging
 * sync for that model. Safe to remove once it's older than the threshold —
 * no legitimate operation on a single-writer repo like this runs that long.
 */
export async function clearStaleLock(modelDir: string): Promise<boolean> {
  const lockPath = join(modelDir, ".git", "index.lock");
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
      await rm(lockPath, { force: true });
      return true;
    }
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function getStatus(modelDir: string): Promise<GitStatusSummary> {
  const status = await clientFor(modelDir).status();
  const paths = new Set<string>();
  for (const f of status.not_added) paths.add(f);
  for (const f of status.created) paths.add(f);
  for (const f of status.modified) paths.add(f);
  for (const f of status.deleted) paths.add(f);
  for (const f of status.renamed) paths.add(f.to);
  return { isClean: status.isClean(), changedPaths: [...paths].sort() };
}

/** Stages everything and commits under the given identity, passed via `-c` (never touches repo git config). */
export async function addAllAndCommit(
  modelDir: string,
  message: string,
  identity: GitIdentity,
): Promise<string> {
  const git = clientFor(modelDir, identity);
  await git.add(["-A"]);
  const result = await git.commit(message);
  return result.commit;
}

/** Restores tracked file contents to their state at `sha`, leaving the change staged for the caller to commit. Never deletes files added since `sha`. */
export async function restoreToCommit(modelDir: string, sha: string): Promise<void> {
  await clientFor(modelDir).raw(["checkout", sha, "--", "."]);
}

export async function getLog(modelDir: string): Promise<GitLogEntry[]> {
  const git = clientFor(modelDir);
  const log = await git.log();
  return log.all.map((entry) => ({
    sha: entry.hash,
    message: entry.message,
    authorName: entry.author_name,
    authorEmail: entry.author_email,
    date: entry.date,
  }));
}
