import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { FileEntry } from "@model-hub/shared";

export const MARKER_FILENAME = ".modelhub-id";
export const GITIGNORE_FILENAME = ".gitignore";
export const THUMBNAILS_DIRNAME = ".thumbnails";
export const MODEL_EXTENSIONS = new Set(["stl", "3mf"]);

const GITIGNORE_MANAGED_ENTRIES = [`${THUMBNAILS_DIRNAME}/`];

export interface EnsureMarkerResult {
  id: string;
  created: boolean;
}

/** Reads (or creates) the stable filesystem identity for a project directory. */
export async function ensureMarkerId(projectDir: string): Promise<EnsureMarkerResult> {
  const markerPath = join(projectDir, MARKER_FILENAME);
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
export async function ensureGitignore(projectDir: string): Promise<EnsureGitignoreResult> {
  const gitignorePath = join(projectDir, GITIGNORE_FILENAME);
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

/**
 * Recursively lists model files (.stl/.3mf) under a project directory.
 * Skips dotfiles/dot-directories (.git, .thumbnails, .modelhub-id, .gitignore).
 */
export async function listProjectFiles(projectDir: string): Promise<FileEntry[]> {
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
      if (!MODEL_EXTENSIONS.has(extension)) continue;

      const info = await stat(fullPath);
      results.push({
        relativePath: relative(projectDir, fullPath).split(sep).join("/"),
        sizeBytes: info.size,
        mtime: info.mtimeMs,
        extension,
      });
    }
  }

  await walk(projectDir);
  return results;
}

/**
 * Picks the file to render for the project thumbnail: prefer .stl over .3mf,
 * then the largest file, breaking ties by path for determinism.
 */
export function pickPrimaryFile(files: FileEntry[]): string | null {
  if (files.length === 0) return null;

  const rank = (file: FileEntry): number => (file.extension === "stl" ? 0 : 1);
  const sorted = [...files].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes;
    return a.relativePath.localeCompare(b.relativePath);
  });

  return sorted[0]?.relativePath ?? null;
}
