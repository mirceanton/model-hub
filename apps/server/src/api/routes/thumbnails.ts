import { createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { models as modelsTable } from "../../db/schema.js";
import { enqueueThumbnail } from "../../thumbnails/trigger.js";

export function registerThumbnailRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Params: { id: string } }>("/api/models/:id/thumbnail", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const model = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
    if (!model?.thumbnailPath) {
      return reply.code(404).send({ error: "no thumbnail for this model" });
    }

    const modelRoot = resolve(model.path);
    const absolutePath = resolve(modelRoot, model.thumbnailPath);
    if (absolutePath !== modelRoot && !absolutePath.startsWith(modelRoot + sep)) {
      return reply.code(400).send({ error: "invalid thumbnail path" });
    }

    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "no-cache");
    return reply.send(createReadStream(absolutePath));
  });

  app.post<{ Params: { id: string } }>(
    "/api/models/:id/thumbnail/regenerate",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid model id" });
      }

      const model = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }
      if (!model.primaryFilePath) {
        return reply.code(400).send({ error: "model has no primary file to render" });
      }

      db.update(modelsTable)
        .set({ thumbnailStatus: "pending" })
        .where(eq(modelsTable.id, id))
        .run();
      enqueueThumbnail(db, model);
      return reply.code(202).send({ ok: true, thumbnailStatus: "pending" });
    },
  );
}
