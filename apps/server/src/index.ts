import { buildApp } from "./api/app.js";
import { loadConfig } from "./config.js";
import { createDbClient } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { scanLibraryRoot } from "./sync/scanner.js";
import { startWatcher } from "./sync/watcher.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDbClient(config.databasePath);
  runMigrations(db);

  const app = buildApp(db, config);

  const initialScan = await scanLibraryRoot(db, config.libraryRoot);
  if (initialScan.skipped) {
    app.log.warn(`initial scan skipped: ${initialScan.reason}`);
  } else {
    app.log.info(`initial scan reconciled ${initialScan.scanned} project(s)`);
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
