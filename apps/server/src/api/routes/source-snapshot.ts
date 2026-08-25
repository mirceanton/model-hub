import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { models as modelsTable } from "../../db/schema.js";
import { getActiveModel } from "../../lib/model-lookup.js";
import { enqueueSourceSnapshot } from "../../source-snapshot/trigger.js";

export function registerSourceSnapshotRoutes(app: FastifyInstance, db: DbClient): void {
  // Manual "refresh snapshot" action — re-fetches sourceUrl and replaces the
  // stored snapshot, for when the user knows the source page has changed
  // since the last automatic fetch (which only runs when sourceUrl itself
  // is set/changed, see api/routes/models.ts's PATCH handler).
  app.post<{ Params: { id: string } }>(
    "/api/models/:id/source-snapshot/refresh",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid model id" });
      }

      const model = getActiveModel(db, id);
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }
      if (!model.sourceUrl) {
        return reply.code(400).send({ error: "model has no sourceUrl to snapshot" });
      }

      db.update(modelsTable)
        .set({ sourceSnapshotStatus: "pending", sourceSnapshotError: null })
        .where(eq(modelsTable.id, id))
        .run();
      enqueueSourceSnapshot(db, model);
      return reply.code(202).send({ ok: true, sourceSnapshotStatus: "pending" });
    },
  );
}
