import type { Dirent } from "node:fs";
import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

export interface LibraryStorageStats {
  /** Total bytes used by every file under libraryRoot, recursive — includes
   * dotfiles/.git/.thumbnails/.modelhub-id, deliberately NOT limited to the
   * `files` DB cache (which only tracks model/attachment files and would
   * understate real disk usage, e.g. git history growth). */
  usedBytes: number;
  /** Total size of the volume libraryRoot is mounted on. */
  volumeTotalBytes: number;
  /** Free space on that volume, including the portion reserved for root. */
  volumeFreeBytes: number;
  /** Free space available to unprivileged users — what "available disk space" usually means to an operator. */
  volumeAvailableBytes: number;
}

/**
 * Recursively sums file sizes under `dir`. Doesn't follow symlinks (avoids
 * cycles) and silently treats an unreadable/vanished entry as 0 bytes rather
 * than failing the whole walk — this runs on demand for the instance stats
 * page (issue #73), and a concurrent git operation or file delete mid-walk
 * shouldn't break it.
 */
async function directorySizeBytes(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const sizes = await Promise.all(
    entries.map(async (entry): Promise<number> => {
      if (entry.isSymbolicLink()) return 0;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) return directorySizeBytes(fullPath);
      if (!entry.isFile()) return 0;
      try {
        const info = await stat(fullPath);
        return info.size;
      } catch {
        return 0;
      }
    }),
  );

  return sizes.reduce((sum, size) => sum + size, 0);
}

/**
 * Gathers library storage stats for the instance stats page (issue #73):
 * actual on-disk usage of LIBRARY_ROOT via a real recursive walk, plus the
 * free/total space of the *volume* LIBRARY_ROOT lives on via `fs.statfs` on
 * LIBRARY_ROOT itself — not `df` on `/`, which in a containerized deployment
 * reports the (usually much smaller, irrelevant) container root filesystem
 * rather than the mounted library volume.
 */
export async function getLibraryStorageStats(libraryRoot: string): Promise<LibraryStorageStats> {
  const [usedBytes, volumeStats] = await Promise.all([
    directorySizeBytes(libraryRoot),
    statfs(libraryRoot),
  ]);

  const blockSize = volumeStats.bsize;
  return {
    usedBytes,
    volumeTotalBytes: volumeStats.blocks * blockSize,
    volumeFreeBytes: volumeStats.bfree * blockSize,
    volumeAvailableBytes: volumeStats.bavail * blockSize,
  };
}
