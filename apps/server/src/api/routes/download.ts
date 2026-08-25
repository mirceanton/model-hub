import { resolve, sep } from "node:path";
import { ZipArchive, type ArchiverError } from "archiver";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { files as filesTable } from "../../db/schema.js";
import { sanitizeModelDirName } from "../../lib/fs-utils.js";
import { getActiveModel } from "../../lib/model-lookup.js";

/** Streams every indexed file of a model as a single zip archive. */
export function registerDownloadRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Params: { id: string } }>("/api/models/:id/download", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const model = getActiveModel(db, id);
    if (!model) {
      return reply.code(404).send({ error: "model not found" });
    }

    const modelFiles = db.select().from(filesTable).where(eq(filesTable.modelId, id)).all();
    const modelRoot = resolve(model.path);
    const filename = sanitizeModelDirName(model.title) ?? "model";

    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${filename}.zip"`);

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("warning", (err: ArchiverError) => request.log.warn(err));
    archive.on("error", (err: ArchiverError) => request.log.error(err));

    for (const file of modelFiles) {
      const absolutePath = resolve(modelRoot, file.relativePath);
      if (absolutePath !== modelRoot && !absolutePath.startsWith(modelRoot + sep)) continue;
      archive.file(absolutePath, { name: file.relativePath });
    }

    void archive.finalize();
    return reply.send(archive);
  });
}
