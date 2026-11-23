import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { sanitizeUploadPath } from "./fs-utils.js";

const STAGING_DIRNAME = "modelhub-staging";

export interface UploadStaging {
  /** Directory the upload's file parts are streamed into before being moved into the model dir. */
  dir: string;
  /** Removes the staging directory and anything still in it. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Creates a private staging directory for one upload request, so file parts
 * can be streamed to disk *without* holding the model's per-path lock (a slow
 * client must not stall the periodic scan) and *without* writing into the
 * model's working tree, where the watcher/scanner would see (and auto-commit)
 * half-written files.
 *
 * Prefers `<model>/.git/modelhub-staging/<uuid>`: same filesystem as the
 * destination (so the later move is an atomic rename), and invisible to
 * everything else by construction — git never tracks its own `.git/`, the
 * watcher ignores any `.git` segment, and listModelFiles skips dot-dirs.
 * Falls back to the OS temp dir when the model has no `.git` directory (the
 * move then degrades to copy + delete — see moveIntoPlace).
 */
export async function createUploadStaging(modelPath: string): Promise<UploadStaging> {
  const gitDir = join(modelPath, ".git");
  const gitDirInfo = await stat(gitDir).catch(() => null);
  const parent = gitDirInfo?.isDirectory() ? join(gitDir, STAGING_DIRNAME) : join(tmpdir(), STAGING_DIRNAME);
  const dir = join(parent, randomUUID());
  await mkdir(dir, { recursive: true });
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Moves a staged file over its destination (creating parent folders): rename when possible, copy + delete across filesystems. */
export async function moveIntoPlace(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

/**
 * Resolves a caller-supplied relative path inside a model dir, or null if
 * sanitizeUploadPath rejects it (or it would somehow still escape the
 * model root). Returns the normalized relative path alongside.
 */
export function resolveModelPath(
  modelPath: string,
  rawRelativePath: string,
): { relativePath: string; absolutePath: string } | null {
  const relativePath = sanitizeUploadPath(rawRelativePath.trim());
  if (!relativePath) return null;
  const modelRoot = resolve(modelPath);
  const absolutePath = resolve(modelRoot, relativePath);
  if (!absolutePath.startsWith(modelRoot + sep)) return null;
  return { relativePath, absolutePath };
}

export type TargetInspection =
  | { ok: true; existing: "file" | "directory" | null }
  | { ok: false; reason: string };

/**
 * Checks what's on disk along a (sanitized) relative path before writing
 * or deleting there. Uses lstat and refuses to go through a symlink at any
 * level — a symlinked subfolder in the model dir (e.g. created over the
 * share) must never let an upload or delete reach outside the model. An
 * ancestor that exists as a file (so the path can't be a folder) is
 * reported as a problem too; missing ancestors are fine (they get created).
 */
export async function inspectTarget(modelPath: string, relativePath: string): Promise<TargetInspection> {
  const segments = relativePath.split("/");
  let current = resolve(modelPath);
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]!);
    const shown = segments.slice(0, i + 1).join("/");
    const info = await lstat(current).catch(() => null);
    if (!info) return { ok: true, existing: null };
    if (info.isSymbolicLink()) return { ok: false, reason: `'${shown}' is a symlink` };
    const isLast = i === segments.length - 1;
    if (!isLast && !info.isDirectory()) return { ok: false, reason: `'${shown}' is a file, not a folder` };
    if (isLast) {
      if (info.isDirectory()) return { ok: true, existing: "directory" };
      if (info.isFile()) return { ok: true, existing: "file" };
      return { ok: false, reason: `'${shown}' is not a regular file` };
    }
  }
  return { ok: true, existing: null };
}

/**
 * After deleting a file, removes the folders it leaves empty, walking up
 * towards (never including) the model root. Git doesn't track empty
 * folders, so leaving them behind would only be clutter on the share.
 * Stops at the first non-empty (or otherwise unremovable) folder.
 */
export async function pruneEmptyParents(modelPath: string, deletedAbsolutePath: string): Promise<void> {
  const modelRoot = resolve(modelPath);
  let dir = dirname(deletedAbsolutePath);
  while (dir !== modelRoot && dir.startsWith(modelRoot + sep)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}
