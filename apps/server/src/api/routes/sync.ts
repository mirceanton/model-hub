import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { scanLibraryRoot } from "../../sync/scanner.js";

/** Manual synchronous trigger for the reconciliation scan — mainly a verification aid. */
export function registerSyncRoutes(app: FastifyInstance, db: DbClient, libraryRoot: string): void {
  app.post("/api/sync", async (_request, reply) => {
    const result = await scanLibraryRoot(db, libraryRoot);
    if (result.skipped) {
      return reply.code(202).send(result);
    }
    return result;
  });
}
