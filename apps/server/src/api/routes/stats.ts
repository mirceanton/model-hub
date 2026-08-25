import type { InstanceStats, ThumbnailStatus } from "@model-hub/shared";
import { isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../../auth/guard.js";
import type { Config } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import { models as modelsTable, projects as projectsTable, tags as tagsTable } from "../../db/schema.js";
import { getAppVersion } from "../../lib/app-version.js";
import { getLibraryStorageStats } from "../../lib/disk-usage.js";
import { getLastScanStats } from "../../metrics/sync-metrics.js";
import { getThumbnailQueueState } from "../../thumbnails/trigger.js";

const THUMBNAIL_STATUSES: ThumbnailStatus[] = ["pending", "generating", "ready", "error"];

/**
 * Instance-wide stats for the Settings/Stats page (issue #73) — storage,
 * counts, thumbnail queue depth, sync health, and instance info. Explicitly
 * global, not per-user (see the issue's scope note), so it's gated the same
 * way as api/routes/admin.ts: requireRole("admin"), consistent with that
 * being the only other instance-settings-flavored surface in the app.
 *
 * Deliberately cheap: no full-library re-scan is triggered by loading this
 * page. The sync/thumbnail numbers below are read from state issue #71's
 * Prometheus metrics work already maintains (sync-metrics.ts's
 * recordScanCompleted, thumbnails/queue.ts's pending/active) rather than
 * recomputed here a second way — the one exception is storage, which has no
 * existing data source and does its own bounded work (a recursive stat walk
 * of LIBRARY_ROOT plus a single fs.statfs call).
 */
export function registerStatsRoutes(app: FastifyInstance, db: DbClient, config: Config): void {
  app.get(
    "/api/stats",
    { preHandler: requireRole("admin") },
    async (): Promise<InstanceStats> => {
      const storage = await getLibraryStorageStats(config.libraryRoot);

      const modelCountRow = db
        .select({ count: sql<number>`count(*)` })
        .from(modelsTable)
        .where(isNull(modelsTable.deletedAt))
        .get();
      const projectCountRow = db.select({ count: sql<number>`count(*)` }).from(projectsTable).get();
      const tagCountRow = db.select({ count: sql<number>`count(*)` }).from(tagsTable).get();

      const thumbnailStatusRows = db
        .select({ status: modelsTable.thumbnailStatus, count: sql<number>`count(*)` })
        .from(modelsTable)
        .where(isNull(modelsTable.deletedAt))
        .groupBy(modelsTable.thumbnailStatus)
        .all();
      const thumbnailStatus = Object.fromEntries(
        THUMBNAIL_STATUSES.map((status) => [status, 0]),
      ) as Record<ThumbnailStatus, number>;
      for (const row of thumbnailStatusRows) {
        thumbnailStatus[row.status] = row.count;
      }

      const syncStatusRows = db
        .select({ status: modelsTable.syncStatus, count: sql<number>`count(*)` })
        .from(modelsTable)
        .where(isNull(modelsTable.deletedAt))
        .groupBy(modelsTable.syncStatus)
        .all();
      const errorModelCount = syncStatusRows.find((r) => r.status === "error")?.count ?? 0;
      const missingModelCount = syncStatusRows.find((r) => r.status === "missing")?.count ?? 0;

      const lastScan = getLastScanStats();
      const thumbnailQueue = getThumbnailQueueState();

      return {
        storage: {
          libraryUsedBytes: storage.usedBytes,
          volumeTotalBytes: storage.volumeTotalBytes,
          volumeFreeBytes: storage.volumeFreeBytes,
          volumeAvailableBytes: storage.volumeAvailableBytes,
        },
        counts: {
          models: modelCountRow?.count ?? 0,
          projects: projectCountRow?.count ?? 0,
          tags: tagCountRow?.count ?? 0,
          thumbnailStatus,
        },
        thumbnailQueue,
        sync: {
          lastScanAt: lastScan ? Math.round(lastScan.timestampSeconds * 1000) : null,
          lastScanDurationSeconds: lastScan?.durationSeconds ?? null,
          errorModelCount,
          missingModelCount,
        },
        instance: {
          version: getAppVersion(),
          oidcEnabled: config.oidc !== null,
          libraryRoot: config.libraryRoot,
        },
      };
    },
  );
}
