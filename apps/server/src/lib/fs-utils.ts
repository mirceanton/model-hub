import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { FileEntry } from "@model-hub/shared";

export const MARKER_FILENAME = ".modelhub-id";
export const GITIGNORE_FILENAME = ".gitignore";
export const THUMBNAILS_DIRNAME = ".thumbnails";
// A trashed model's directory is moved here (see api/routes/models.ts's DELETE
// handler and api/routes/trash.ts), one level under LIBRARY_ROOT — kept
// physically out of the scanner's/watcher's normal model-discovery walk
// (sync/scanner.ts excludes this exact top-level name) rather than deleted,
// so a misclick is recoverable within the retention window.
export const TRASH_DIRNAME = ".trash";
export const MODEL_EXTENSIONS = new Set(["stl", "3mf", "obj", "step", "stp"]);
// Images and PDFs: recognized as model *attachments* (build photos,
// instruction sheets) alongside the mesh files, but deliberately never a
// candidate for the 3D viewer or the primary-file/thumbnail-source ranking
// (EXTENSION_RANK/pickPrimaryFile below both only ever consider
// MODEL_EXTENSIONS). Kept as a separate set (not merged into
// MODEL_EXTENSIONS) so every existing MODEL_EXTENSIONS check keeps meaning
// exactly "a mesh file", not "any tracked file".
export const ATTACHMENT_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "pdf"]);
const TRACKED_EXTENSIONS = new Set([...MODEL_EXTENSIONS, ...ATTACHMENT_EXTENSIONS]);

const GITIGNORE_MANAGED_ENTRIES = [`${THUMBNAILS_DIRNAME}/`, ".DS_Store"];

export interface EnsureMarkerResult {
  id: string;
  created: boolean;
}

/** Reads (or creates) the stable filesystem identity for a model directory. */
export async function ensureMarkerId(modelDir: string): Promise<EnsureMarkerResult> {
  const markerPath = join(modelDir, MARKER_FILENAME);
  try {
    const existing = (await readFile(markerPath, "utf8")).trim();
    if (existing.length > 0) {
      return { id: existing, created: false };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const id = randomUUID();
  await writeFile(markerPath, `${id}\n`, "utf8");
  return { id, created: true };
}

export interface EnsureGitignoreResult {
  modified: boolean;
}

/** Ensures generated artifacts (currently just .thumbnails/) are never committed. */
export async function ensureGitignore(modelDir: string): Promise<EnsureGitignoreResult> {
  const gitignorePath = join(modelDir, GITIGNORE_FILENAME);
  let existingLines: string[] = [];
  let existed = false;

  try {
    const content = await readFile(gitignorePath, "utf8");
    existed = true;
    existingLines = content.split("\n").map((line) => line.trimEnd());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const missing = GITIGNORE_MANAGED_ENTRIES.filter((entry) => !existingLines.includes(entry));
  if (missing.length === 0 && existed) {
    return { modified: false };
  }

  const nextLines = [...existingLines.filter((line) => line.length > 0), ...missing];
  await writeFile(gitignorePath, `${nextLines.join("\n")}\n`, "utf8");
  return { modified: true };
}

function extensionOf(filename: string): string {
  return extname(filename).slice(1).toLowerCase();
}

/** True for a model file (MODEL_EXTENSIONS) or attachment (ATTACHMENT_EXTENSIONS) extension — the same allowlist listModelFiles applies when walking the live working tree. Exported so project export (which reads a historical git commit's tree instead of the live filesystem, so can't just reuse listModelFiles/the `files` DB cache) can apply the identical filter. */
export function isTrackedExtension(extension: string): boolean {
  return TRACKED_EXTENSIONS.has(extension.toLowerCase());
}

/** True when any path segment is a dotfile/dot-directory (.git, .thumbnails, .modelhub-id, .gitignore, .DS_Store, ...) — the same skip listModelFiles applies while walking. */
export function isDotPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Recursively lists model files (.stl/.3mf/.obj/.step/.stp) and attachment files
 * (images/pdf — ATTACHMENT_EXTENSIONS) under a model directory. Skips
 * dotfiles/dot-directories (.git, .thumbnails, .modelhub-id, .gitignore).
 */
export async function listModelFiles(modelDir: string): Promise<FileEntry[]> {
  const results: FileEntry[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = extensionOf(entry.name);
      if (!TRACKED_EXTENSIONS.has(extension)) continue;

      const info = await stat(fullPath);
      results.push({
        relativePath: relative(modelDir, fullPath).split(sep).join("/"),
        sizeBytes: info.size,
        mtime: info.mtimeMs,
        extension,
      });
    }
  }

  await walk(modelDir);
  return results;
}

// Preference order when a model has multiple file types: .stl (single, unambiguous
// mesh) > .obj (single mesh, no embedded slicer metadata) > .3mf (can be a
// multi-plate "sliced project" export with no mesh at all — see MODEL_EXTENSIONS
// callers' EmptyGeometryError handling). .step/.stp are deliberately unranked:
// they fall through to the ?? 99 default, so a mesh file present in the same
// directory always wins, while a model whose only model file is a CAD export
// still gets a thumbnail (largest-file fallback below). Unlisted extensions
// (including every ATTACHMENT_EXTENSIONS entry) fall through to that same
// default, but in practice never reach this ranking at all — pickPrimaryFile
// filters to MODEL_EXTENSIONS before this is ever consulted.
const EXTENSION_RANK: Record<string, number> = { stl: 0, obj: 1, "3mf": 2 };

/**
 * Picks the file to render for the model thumbnail: prefer .stl, then .obj,
 * then .3mf, then the largest remaining model file (.step/.stp included),
 * breaking ties by path for determinism. Attachment files (images/pdf) are
 * filtered out up front — never candidates for the viewer or thumbnail source,
 * regardless of EXTENSION_RANK's fallback for unlisted extensions.
 */
export function pickPrimaryFile(files: FileEntry[]): string | null {
  const modelFiles = files.filter((f) => MODEL_EXTENSIONS.has(f.extension));
  if (modelFiles.length === 0) return null;

  const rank = (file: FileEntry): number => EXTENSION_RANK[file.extension] ?? 99;
  const sorted = [...modelFiles].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
    return a.relativePath.localeCompare(b.relativePath);
  });

  return sorted[0]?.relativePath ?? null;
}

// Characters that are invalid in a Windows/SMB path segment (the library
// root may be an SMB share), plus control characters. Checked per segment.
const FORBIDDEN_PATH_SEGMENT_CHARS = /[<>:"|?*\x00-\x1f]/;
export const MAX_UPLOAD_PATH_DEPTH = 16;
const MAX_UPLOAD_PATH_LENGTH = 1024;
const MAX_PATH_SEGMENT_LENGTH = 255;

/**
 * Validates a client-supplied path for a file inside a model directory and
 * returns it normalized ("parts/arm.stl", "/"-separated), or null if it's
 * not acceptable. Used for upload filenames (which may carry subfolders)
 * and for paths to delete.
 *
 * Rejects rather than repairs anything suspicious, so a crafted name can
 * never land somewhere other than what the client literally asked for:
 * absolute paths, `.`/`..`/empty segments, any dot-segment (.git,
 * .modelhub-id, .thumbnails, ...), SMB-invalid characters (incl. drive
 * letters' `:`), segments with leading/trailing spaces or a trailing dot,
 * and anything outside MODEL_EXTENSIONS/ATTACHMENT_EXTENSIONS. Backslashes
 * are treated as separators. Depth is capped well inside the watcher's
 * chokidar depth so every accepted file is still watched.
 */
export function sanitizeUploadPath(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, "/");
  if (!normalized || normalized.length > MAX_UPLOAD_PATH_LENGTH || normalized.startsWith("/")) return null;

  const segments = normalized.split("/");
  if (segments.length > MAX_UPLOAD_PATH_DEPTH) return null;
  for (const segment of segments) {
    if (!segment || segment.length > MAX_PATH_SEGMENT_LENGTH) return null;
    if (segment.startsWith(".")) return null; // also covers "." and ".."
    if (segment !== segment.trim() || segment.endsWith(".")) return null;
    if (FORBIDDEN_PATH_SEGMENT_CHARS.test(segment)) return null;
  }

  if (!TRACKED_EXTENSIONS.has(extensionOf(segments[segments.length - 1]!))) return null;
  return segments.join("/");
}

/**
 * Returns a path from `paths` that some *other* entry needs as a folder
 * (e.g. "a.stl" alongside "a.stl/b.stl"), or null. Such a set can't be
 * written to disk, so callers reject it up front instead of failing halfway.
 */
export function findFileFolderClash(paths: string[]): string | null {
  const set = new Set(paths);
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join("/");
      if (set.has(ancestor)) return ancestor;
    }
  }
  return null;
}

const FORBIDDEN_DIR_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const MAX_MODEL_DIR_NAME_LENGTH = 100;

/**
 * Reduces a user-supplied model title to a directory name safe to create
 * directly under LIBRARY_ROOT, or null if nothing usable is left. Strips
 * path separators and other Windows-incompatible characters (the library
 * root may be an SMB/NFS mount) rather than fully slugifying, so the
 * directory stays recognizable next to the title.
 */
export function sanitizeModelDirName(rawTitle: string): string | null {
  const collapsed = rawTitle
    .replace(FORBIDDEN_DIR_NAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");

  if (!collapsed) return null;

  const truncated =
    collapsed.length > MAX_MODEL_DIR_NAME_LENGTH
      ? collapsed.slice(0, MAX_MODEL_DIR_NAME_LENGTH).trim()
      : collapsed;

  return truncated || null;
}

/**
 * Picks a filesystem-safe, collision-free subdirectory name for a model
 * being written into a multi-model zip export, preferring its title. Shared
 * by every export route that bundles more than one model into a single zip
 * (project export's pinned models, and models.ts's multi/full-library
 * export) so two models sanitizing to the same name never collide inside
 * the archive.
 */
export function makeDirNamePicker() {
  const used = new Set<string>();
  return (title: string, modelId: number): string => {
    const base = sanitizeModelDirName(title) ?? `model-${modelId}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base} (${suffix})`;
      suffix++;
    }
    used.add(candidate);
    return candidate;
  };
}
