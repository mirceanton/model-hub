import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthGuard } from "../auth/guard.js";
import type { Config } from "../config.js";
import type { DbClient } from "../db/client.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDownloadRoutes } from "./routes/download.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerProjectRoutes } from "./routes/projects.js";
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

  registerHealthRoute(app);
  registerAuthGuard(app, db, config);
  registerAuthRoutes(app, db, config);
  registerAdminRoutes(app, db);
  registerModelRoutes(app, db, config.libraryRoot);
  registerProjectRoutes(app, db);
  registerFileRoutes(app, db);
  registerDownloadRoutes(app, db);
  registerVersionRoutes(app, db);
  registerThumbnailRoutes(app, db);
  registerTagRoutes(app, db);
  registerTrashRoutes(app, db, config.libraryRoot);
  registerSyncRoutes(app, db, config.libraryRoot);

  if (config.staticWebDir) {
    registerStaticSpa(app, config.staticWebDir);
  }

  return app;
}
