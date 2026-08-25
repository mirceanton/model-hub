import { spawn } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { simpleGit, type SimpleGit } from "simple-git";
import type { FileChangeEntry, GitLogEntry } from "@model-hub/shared";

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

/** Returns the SHA of HEAD, or null when the repo has no commits yet. */
export async function getHeadSha(modelDir: string): Promise<string | null> {
  try {
    const sha = await clientFor(modelDir).revparse(["HEAD"]);
    return sha.trim() || null;
  } catch {
    return null;
  }
}

export interface CommitTreeEntry {
  /** Path relative to the repo root, e.g. "part.stl" or "renders/front.png". */
  path: string;
  /** The blob's object sha — passed to catFileBlobStream to read its content. */
  blobSha: string;
}

/**
 * Lists every file (recursively, blobs only — trees/submodules skipped) as
 * it existed at `sha`, without touching the working tree or index. Used by
 * the project export route to read a pinned model at its pinned commit
 * rather than its current on-disk state — see api/routes/project-export.ts.
 */
export async function listFilesAtCommit(modelDir: string, sha: string): Promise<CommitTreeEntry[]> {
  const git = clientFor(modelDir);
  // -z (NUL-terminated records) makes this safe against filenames containing
  // newlines; --name-only would still leave the mode/type/sha prefix to
  // parse, so this uses git's default `<mode> SP <type> SP <sha> TAB <path>` format.
  const raw = await git.raw(["ls-tree", "-r", "-z", sha]);
  const entries: CommitTreeEntry[] = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tabIndex = record.indexOf("\t");
    if (tabIndex === -1) continue;
    const [, type, blobSha] = record.slice(0, tabIndex).split(" ");
    if (type !== "blob" || !blobSha) continue; // skip nested trees (shouldn't occur, -r flattens them) and submodules
    entries.push({ path: record.slice(tabIndex + 1), blobSha });
  }
  return entries;
}

/**
 * Streams a blob's content straight from git's object store by its sha
 * (obtained from listFilesAtCommit), without buffering the whole file in
 * memory — used to feed archiver.append() directly for project export.
 * Spawned directly (not via simple-git) because simple-git's string-based
 * API isn't binary-safe, and its only binary option (binaryCatFile)
 * buffers the entire blob before resolving.
 */
export function catFileBlobStream(modelDir: string, blobSha: string): Readable {
  const child = spawn("git", ["cat-file", "-p", blobSha], {
    cwd: modelDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Surface a non-zero exit (e.g. a corrupt/missing object) as an 'error' on
  // the stream archiver is already listening to, instead of it silently
  // truncating the entry.
  let stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  child.on("close", (code) => {
    if (code !== 0) {
      child.stdout.emit(
        "error",
        new Error(`git cat-file -p ${blobSha} exited with code ${code}: ${Buffer.concat(stderrChunks).toString("utf8")}`),
      );
    }
  });
  child.on("error", (err) => child.stdout.emit("error", err));
  return child.stdout;
}

const NAME_STATUS_CODES: Record<string, FileChangeEntry["status"]> = {
  A: "added",
  M: "modified",
  D: "removed",
};

/**
 * File-level changes between two commits (`git diff --name-status`), used
 * by GET /api/models/:id/diff to preview a project pin bump before
 * committing to it — see api/routes/versions.ts and lib/model-diff.ts.
 * Uses simple-git's raw diff() (it cleanly supports arbitrary args and
 * returns the raw string, unlike diffSummary()'s --stat-derived shape,
 * which has no add/modify/remove status) rather than a direct spawn like
 * catFileBlobStream — no binary-safety concern here, this is just short
 * status+path text. --no-renames keeps statuses to a plain A/M/D set
 * matching FileChangeEntry's three categories, rather than surfacing R/C
 * rename-detection statuses the caller would have to special-case. -z
 * NUL-terminates each field (not just each record) so a status and its
 * path are two separate NUL-terminated tokens, safe against filenames
 * containing tabs or newlines.
 */
export async function getFileDiff(modelDir: string, from: string, to: string): Promise<FileChangeEntry[]> {
  const git = clientFor(modelDir);
  const raw = await git.diff(["--name-status", "--no-renames", "-z", from, to]);
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const entries: FileChangeEntry[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const code = tokens[i];
    const path = tokens[i + 1];
    const status = code ? NAME_STATUS_CODES[code] : undefined;
    if (!status || !path) continue; // unexpected/unmapped status code — skip rather than mis-tag it
    entries.push({ path, status });
  }
  return entries;
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
