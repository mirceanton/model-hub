import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthGuard } from "../auth/guard.js";
import type { Config } from "../config.js";
import type { DbClient } from "../db/client.js";
import { registerHttpMetrics } from "../metrics/http-metrics.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerApiTokenRoutes } from "./routes/api-tokens.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDownloadRoutes } from "./routes/download.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerMetricsRoute } from "./routes/metrics.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSourceSnapshotRoutes } from "./routes/source-snapshot.js";
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
  registerAuthRoutes(app, db, config);
  registerAdminRoutes(app, db);
  registerApiTokenRoutes(app, db);
  registerModelRoutes(app, db, config.libraryRoot, config);
  registerProjectRoutes(app, db);
  registerFileRoutes(app, db);
  registerDownloadRoutes(app, db);
  registerVersionRoutes(app, db, config);
  registerThumbnailRoutes(app, db);
  registerSourceSnapshotRoutes(app, db);
  registerTagRoutes(app, db);
  registerTrashRoutes(app, db, config.libraryRoot);
  registerSyncRoutes(app, db, config.libraryRoot);

  if (config.staticWebDir) {
    registerStaticSpa(app, config.staticWebDir);
  }

  return app;
}
