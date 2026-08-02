import Fastify, { type FastifyInstance } from "fastify";
import type { DbClient } from "../db/client.js";
import type { Config } from "../config.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerVersionRoutes } from "./routes/versions.js";

export function buildApp(db: DbClient, config: Config): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
    },
  });

  registerHealthRoute(app);
  registerProjectRoutes(app, db);
  registerFileRoutes(app, db);
  registerVersionRoutes(app, db);
  registerSyncRoutes(app, db, config.libraryRoot);

  return app;
}
