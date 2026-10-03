import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { FileEntry } from "@model-hub/shared";

export const MARKER_FILENAME = ".modelhub-id";
export const GITIGNORE_FILENAME = ".gitignore";
export const THUMBNAILS_DIRNAME = ".thumbnails";
export const TRASH_DIRNAME = ".trash";
export const MODEL_EXTENSIONS = new Set(["stl", "3mf", "obj", "step", "stp"]);
export const ATTACHMENT_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "pdf"]);
const TRACKED_EXTENSIONS = new Set([...MODEL_EXTENSIONS, ...ATTACHMENT_EXTENSIONS]);

const GITIGNORE_MANAGED_ENTRIES = [`${THUMBNAILS_DIRNAME}/`, ".DS_Store"];

export interface EnsureMarkerResult {
  id: string;
  created: boolean;
}

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

export function isTrackedExtension(extension: string): boolean {
  return TRACKED_EXTENSIONS.has(extension.toLowerCase());
}

export function isDotPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

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

const EXTENSION_RANK: Record<string, number> = { stl: 0, obj: 1, "3mf": 2, step: 3, stp: 3 };

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

export function sanitizeUploadFilename(rawName: string): string | null {
  const base = basename(rawName.replace(/\\/g, "/")).trim();
  if (!base || base === "." || base === "..") return null;
  if (!TRACKED_EXTENSIONS.has(extensionOf(base))) return null;
  return base;
}

const FORBIDDEN_DIR_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const MAX_MODEL_DIR_NAME_LENGTH = 100;

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