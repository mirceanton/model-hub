import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { files as filesTable, models as modelsTable } from "../../db/schema.js";

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  stl: "model/stl",
  "3mf": "model/3mf",
};

/** Streams raw model file bytes for the viewer/thumbnail renderer. Only serves files already indexed in the `files` table — never arbitrary paths. */
export function registerFileRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Params: { id: string; "*": string } }>(
    "/api/models/:id/files/*",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid model id" });
      }

      const model = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }

      const relativePath = request.params["*"];
      const fileRow = db
        .select()
        .from(filesTable)
        .where(and(eq(filesTable.modelId, id), eq(filesTable.relativePath, relativePath)))
        .get();
      if (!fileRow) {
        return reply.code(404).send({ error: "file not found" });
      }

      const modelRoot = resolve(model.path);
      const absolutePath = resolve(modelRoot, relativePath);
      if (absolutePath !== modelRoot && !absolutePath.startsWith(modelRoot + sep)) {
        return reply.code(400).send({ error: "invalid path" });
      }

      // The `files` cache can lag reality — e.g. right after the model's
      // whole directory has gone missing but before that's fully reflected
      // — so confirm the file is actually still there rather than letting a
      // mid-stream ENOENT surface as an unhandled 500.
      const exists = await stat(absolutePath)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        return reply.code(404).send({ error: "file no longer exists on disk" });
      }

      reply.header("Content-Type", CONTENT_TYPE_BY_EXTENSION[fileRow.extension] ?? "application/octet-stream");
      reply.header("Content-Length", fileRow.sizeBytes);
      reply.header("Cache-Control", "no-cache");
      return reply.send(createReadStream(absolutePath));
    },
  );
}
