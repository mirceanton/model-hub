import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { models as modelsTable } from "../../db/schema.js";
import { THUMBNAILS_DIRNAME } from "../../lib/fs-utils.js";
import { getActiveModel } from "../../lib/model-lookup.js";
import { THUMBNAIL_FILENAME } from "../../thumbnails/generate.js";
import { enqueueThumbnail } from "../../thumbnails/trigger.js";

export function registerThumbnailRoutes(app: FastifyInstance, db: DbClient): void {
  // Deliberately NOT filtered to active-only models: the Trash view
  // (apps/web/src/routes/trash.tsx) renders a trashed model's thumbnail via
  // this exact endpoint, and the thumbnail file itself travels with the
  // directory when it's moved into .trash/, so it's still valid to serve.
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

      const model = getActiveModel(db, id);
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }
      if (!model.primaryFilePath) {
        return reply.code(400).send({ error: "model has no primary file to render" });
      }

      db.update(modelsTable)
        .set({ thumbnailStatus: "pending", thumbnailSource: "auto" })
        .where(eq(modelsTable.id, id))
        .run();
      enqueueThumbnail(db, model);
      return reply.code(202).send({ ok: true, thumbnailStatus: "pending" });
    },
  );

  // Lets a user pose the model in the interactive viewer (orbit/pan/zoom) and
  // save that exact framing as the thumbnail, instead of whatever angle the
  // headless auto-render pipeline picked. Marked "manual" so the sync-triggered
  // auto-regeneration path (thumbnails/trigger.ts's maybeEnqueueThumbnail)
  // leaves it alone on future content changes — see that function's comment.
  app.post<{ Params: { id: string } }>("/api/models/:id/thumbnail/capture", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const model = getActiveModel(db, id);
    if (!model) {
      return reply.code(404).send({ error: "model not found" });
    }

    const part = await request.file();
    if (!part || !part.mimetype.startsWith("image/")) {
      return reply.code(400).send({ error: "an image file is required" });
    }

    const thumbnailsDir = join(model.path, THUMBNAILS_DIRNAME);
    await mkdir(thumbnailsDir, { recursive: true });
    await pipeline(part.file, createWriteStream(join(thumbnailsDir, THUMBNAIL_FILENAME)));

    db.update(modelsTable)
      .set({
        thumbnailPath: `${THUMBNAILS_DIRNAME}/${THUMBNAIL_FILENAME}`,
        thumbnailStatus: "ready",
        thumbnailSource: "manual",
        updatedAt: new Date(),
      })
      .where(eq(modelsTable.id, id))
      .run();

    return reply.code(200).send({ ok: true, thumbnailStatus: "ready" });
  });
}
