import { join, relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { models as modelsTable } from "../db/schema.js";
import { maybeEnqueueThumbnail } from "../thumbnails/trigger.js";
import { reconcileModel } from "./reconcile.js";

export interface WatcherOptions {
  libraryRoot: string;
  usePolling: boolean;
  debounceMs: number;
}

/**
 * Snappier local-feedback accelerator, secondary to the periodic scan (the
 * real backstop — see scanner.ts). Debounces per top-level model directory
 * and only reconciles models already known to the DB; a brand new
 * directory is picked up by the next full scan instead of duplicating the
 * scanner's identity-adoption logic here.
 */
export function startWatcher(
  db: DbClient,
  options: WatcherOptions,
  onLog: (message: string) => void,
): FSWatcher {
  const timers = new Map<string, NodeJS.Timeout>();

  const watcher = chokidar.watch(options.libraryRoot, {
    ignored: (path: string) => {
      const rel = relative(options.libraryRoot, path);
      return rel.split(sep).some((segment) => segment === ".git" || segment === ".thumbnails");
    },
    ignoreInitial: true,
    depth: 20,
    usePolling: options.usePolling,
  });

  function scheduleReconcile(changedPath: string): void {
    const rel = relative(options.libraryRoot, changedPath);
    const topLevelDir = rel.split(sep)[0];
    if (!topLevelDir || topLevelDir === "..") return;

    const existingTimer = timers.get(topLevelDir);
    if (existingTimer) clearTimeout(existingTimer);

    timers.set(
      topLevelDir,
      setTimeout(() => {
        timers.delete(topLevelDir);
        void reconcileKnownModel(db, options.libraryRoot, topLevelDir, onLog);
      }, options.debounceMs),
    );
  }

  watcher.on("add", scheduleReconcile);
  watcher.on("change", scheduleReconcile);
  watcher.on("unlink", scheduleReconcile);
  watcher.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    onLog(`watcher error: ${message}`);
  });

  return watcher;
}

async function reconcileKnownModel(
  db: DbClient,
  libraryRoot: string,
  topLevelDir: string,
  onLog: (message: string) => void,
): Promise<void> {
  const modelPath = join(libraryRoot, topLevelDir);
  const row = db.select().from(modelsTable).where(eq(modelsTable.path, modelPath)).get();
  if (!row) {
    onLog(`watcher: no known model at ${modelPath} yet; next full scan will adopt it`);
    return;
  }
  const result = await reconcileModel(db, row);
  maybeEnqueueThumbnail(db, row, result);
}
