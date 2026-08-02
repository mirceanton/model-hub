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

function clientFor(projectDir: string, identity?: GitIdentity): SimpleGit {
  return simpleGit({
    baseDir: projectDir,
    config: identity ? [`user.name=${identity.name}`, `user.email=${identity.email}`] : [],
  });
}

export async function isGitRepo(projectDir: string): Promise<boolean> {
  try {
    const info = await stat(join(projectDir, ".git"));
    return info.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function initRepo(projectDir: string): Promise<void> {
  await clientFor(projectDir).init(false);
}

/**
 * A crash mid-commit can leave `.git/index.lock` behind, permanently wedging
 * sync for that project. Safe to remove once it's older than the threshold —
 * no legitimate operation on a single-writer repo like this runs that long.
 */
export async function clearStaleLock(projectDir: string): Promise<boolean> {
  const lockPath = join(projectDir, ".git", "index.lock");
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

export async function getStatus(projectDir: string): Promise<GitStatusSummary> {
  const status = await clientFor(projectDir).status();
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
  projectDir: string,
  message: string,
  identity: GitIdentity,
): Promise<string> {
  const git = clientFor(projectDir, identity);
  await git.add(["-A"]);
  const result = await git.commit(message);
  return result.commit;
}

export async function getLog(projectDir: string): Promise<GitLogEntry[]> {
  const git = clientFor(projectDir);
  const log = await git.log();
  return log.all.map((entry) => ({
    sha: entry.hash,
    message: entry.message,
    authorName: entry.author_name,
    authorEmail: entry.author_email,
    date: entry.date,
  }));
}
