import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { isDotPath, isTrackedExtension } from "./fs-utils.js";

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

/** Moves a staged file over its destination: rename when possible, copy + delete across filesystems. */
export async function moveIntoPlace(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(source, destination);
    await rm(source, { force: true });
  }
}

/**
 * Validates a caller-supplied relative path for deletion as part of an
 * upload changeset, returning its absolute path or null if it isn't
 * acceptable: must stay inside the model dir, must not touch any dot-path
 * (.git, .modelhub-id, .gitignore, .thumbnails, ...), and must be a tracked
 * model/attachment extension — the same set of files the app itself
 * indexes, so a changeset can never delete anything the UI couldn't.
 */
export function resolveDeletePath(modelPath: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return null;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  if (isDotPath(normalized)) return null;
  if (!isTrackedExtension(extname(normalized).slice(1))) return null;

  const modelRoot = resolve(modelPath);
  const absolutePath = resolve(modelRoot, normalized);
  if (!absolutePath.startsWith(modelRoot + sep)) return null;
  return absolutePath;
}
