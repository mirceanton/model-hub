import { buildApp } from "./api/app.js";
import { initOidcClient } from "./auth/oidc.js";
import { loadConfig } from "./config.js";
import { createDbClient } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { scanLibraryRoot } from "./sync/scanner.js";
import { startWatcher } from "./sync/watcher.js";
import { closeBrowser } from "./thumbnails/browser.js";
import { initThumbnailPipeline, sweepPendingThumbnails } from "./thumbnails/trigger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDbClient(config.databasePath);
  runMigrations(db);

  if (config.oidc) {
    await initOidcClient(config.oidc);
  }

  const app = buildApp(db, config);
  app.log.info(config.oidc ? `OIDC auth enabled (issuer: ${config.oidc.issuerUrl})` : "single-user mode (no OIDC configured)");
  app.addHook("onClose", async () => {
    await closeBrowser();
  });

  // Thumbnail rendering fetches model file bytes back through this same API
  // (the headless page hits /api/models/:id/files/*), so the pipeline must
  // not start dequeuing jobs until app.listen() below has actually bound the
  // port — enqueue calls before that are harmless no-ops (see trigger.ts).
  const initialScan = await scanLibraryRoot(db, config.libraryRoot);
  if (initialScan.skipped) {
    app.log.warn(`initial scan skipped: ${initialScan.reason}`);
  } else {
    app.log.info(`initial scan reconciled ${initialScan.scanned} model(s)`);
  }

  const scanInterval = setInterval(() => {
    void scanLibraryRoot(db, config.libraryRoot).then((result) => {
      if (result.skipped) {
        app.log.warn(`periodic scan skipped: ${result.reason}`);
      }
    });
  }, config.libraryScanIntervalMs);
  scanInterval.unref();

  if (config.libraryWatchEnabled) {
    const watcher = startWatcher(
      db,
      {
        libraryRoot: config.libraryRoot,
        usePolling: config.libraryWatchUsePolling,
        debounceMs: config.syncDebounceMs,
      },
      (message) => app.log.info(message),
    );
    app.addHook("onClose", async () => {
      await watcher.close();
    });
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });

  initThumbnailPipeline(config.thumbnailConcurrency, config.webBaseUrl);
  sweepPendingThumbnails(db);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
