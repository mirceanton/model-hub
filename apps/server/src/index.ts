import { buildApp } from "./api/app.js";
import { initOidcClient } from "./auth/oidc.js";
import { loadConfig } from "./config.js";
import { createDbClient } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { enforceAdminGroupMappings } from "./lib/auth-settings.js";
import { initSourceSnapshotPipeline, sweepPendingSourceSnapshots } from "./source-snapshot/trigger.js";
import { purgeExpiredTrash, scanLibraryRoot } from "./sync/scanner.js";
import { startWatcher } from "./sync/watcher.js";
import { closeBrowser } from "./thumbnails/browser.js";
import { initThumbnailPipeline, sweepPendingThumbnails } from "./thumbnails/trigger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDbClient(config.databasePath);
  runMigrations(db);

  // OIDC_ADMIN_GROUPS is meaningless in single-user mode (the local-owner
  // path already grants full access unconditionally) -- no-op rather than
  // error if it's set there, since someone might leave it set across a mode
  // switch. "The env var always wins": this runs on every boot so the
  // configured groups can never be locked out of the /admin UI that
  // manages the mapping table it writes to.
  if (config.oidc) {
    enforceAdminGroupMappings(db, config.oidcAdminGroups);
  }

  // Unlike the thumbnail pipeline, this only ever fetches *other* servers,
  // so it has no dependency on this server's own app.listen() having bound
  // yet — safe to start (and sweep any snapshot fetches a crash left
  // "pending") right away.
  initSourceSnapshotPipeline();
  sweepPendingSourceSnapshots(db);

  if (config.oidc) {
    await initOidcClient(config.oidc);
  }

  const app = buildApp(db, config);
  app.log.info(config.oidc ? `OIDC auth enabled (issuer: ${config.oidc.issuerUrl})` : "single-user mode (no OIDC configured)");
  if (config.oidc && config.oidcAdminGroups.length > 0) {
    app.log.info(`enforced ${config.oidcAdminGroups.length} admin group mapping(s) from OIDC_ADMIN_GROUPS`);
  }
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

  const initialPurge = await purgeExpiredTrash(db);
  if (initialPurge.purged > 0) {
    app.log.info(`initial trash sweep purged ${initialPurge.purged} expired item(s)`);
  }

  // Trash retention purge rides the same tick as the library scan rather than
  // its own interval — see scanner.ts's purgeExpiredTrash.
  const scanInterval = setInterval(() => {
    void scanLibraryRoot(db, config.libraryRoot).then((result) => {
      if (result.skipped) {
        app.log.warn(`periodic scan skipped: ${result.reason}`);
      }
    });
    void purgeExpiredTrash(db).then((result) => {
      if (result.purged > 0) {
        app.log.info(`trash sweep purged ${result.purged} expired item(s)`);
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
