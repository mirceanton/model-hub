import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthGuard } from "../auth/guard.js";
import type { Config } from "../config.js";
import type { DbClient } from "../db/client.js";
import { registerHttpMetrics } from "../metrics/http-metrics.js";
import { registerOpenApi } from "./openapi.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerApiTokenRoutes } from "./routes/api-tokens.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDownloadRoutes } from "./routes/download.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerMetricsRoute } from "./routes/metrics.js";
import { registerModelExportRoutes } from "./routes/model-export.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerProjectExportRoutes } from "./routes/project-export.js";
import { registerProjectThumbnailRoutes } from "./routes/project-thumbnails.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSourceSnapshotRoutes } from "./routes/source-snapshot.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerTagRoutes } from "./routes/tags.js";
import { registerThumbnailRoutes } from "./routes/thumbnails.js";
import { registerTrashRoutes } from "./routes/trash.js";
import { registerVersionRoutes } from "./routes/versions.js";
import { registerStaticSpa } from "./static.js";

// Generous for large/multi-plate sliced files — shared by both the create-model
// and upload-new-version routes, which both accept raw .stl/.3mf/.obj uploads.
const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024; // 1GB

export function buildApp(db: DbClient, config: Config): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
    },
  });

  app.register(cookie, { secret: config.sessionSecret ?? undefined });
  app.register(multipart, { limits: { fileSize: MAX_UPLOAD_FILE_BYTES } });
  // global: false -- limits are applied per-route (via each route's `config.rateLimit`,
  // see lib/rate-limit.ts), never as a blanket default across every route.
  app.register(rateLimit, { global: false });

  // Registered first so its onResponse hook wraps every route below,
  // including the auth guard's own 401s and the SPA fallback's 404s.
  registerHttpMetrics(app);

  registerHealthRoute(app);
  registerMetricsRoute(app);
  registerAuthGuard(app, db, config);
  // Registered right after the guard (whose onRequest hook, added directly
  // to `app` rather than through `app.register`, applies to every route
  // declared afterwards regardless of sync/async timing — see auth/guard.ts)
  // so /docs is gated the same way /api/* is.
  registerOpenApi(app);

  // Every route module below is wrapped in `app.register(async (instance) =>
  // ...)` — not just called directly on `app` — so its routes are added
  // through avvio's plugin queue *after* the `@fastify/swagger` /
  // `@fastify/swagger-ui` registration inside registerOpenApi above has
  // actually run. This matters specifically for `@fastify/swagger`'s
  // `onRoute` hook: unlike `onRequest` (a request-time hook, unaffected by
  // this), `onRoute` fires synchronously the instant a route is declared.
  // `app.get()`/`app.post()` calls made directly on `app` run immediately,
  // in the same tick as the rest of this function — well before any
  // `app.register()`'d plugin (swagger included) actually executes, since
  // `register()` always defers to avvio's boot phase. Left unwrapped, every
  // route below would be declared before swagger's `onRoute` hook even
  // exists, and the generated spec would have zero paths (verified via a
  // minimal repro during development of issue #70 — this is not
  // hypothetical). Wrapping in `register()` queues these calls to run
  // *after* registerOpenApi's queued plugins finish, so the hook is already
  // attached by the time any of these routes are declared.
  app.register(async (instance) => {
    registerAuthRoutes(instance, db, config);
    registerAdminRoutes(instance, db);
    registerStatsRoutes(instance, db, config);
    registerApiTokenRoutes(instance, db);
    registerModelRoutes(instance, db, config.libraryRoot, config);
    registerModelExportRoutes(instance, db);
    registerProjectRoutes(instance, db);
    registerProjectExportRoutes(instance, db);
    registerProjectThumbnailRoutes(instance, db);
    registerFileRoutes(instance, db);
    registerDownloadRoutes(instance, db);
    registerVersionRoutes(instance, db, config);
    registerThumbnailRoutes(instance, db);
    registerSourceSnapshotRoutes(instance, db);
    registerTagRoutes(instance, db);
    registerTrashRoutes(instance, db, config.libraryRoot);
    registerSyncRoutes(instance, db, config.libraryRoot);
  });

  if (config.staticWebDir) {
    registerStaticSpa(app, config.staticWebDir);
  }

  return app;
}
