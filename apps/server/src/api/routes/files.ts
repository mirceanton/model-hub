import { createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { files as filesTable, projects as projectsTable } from "../../db/schema.js";

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  stl: "model/stl",
  "3mf": "model/3mf",
};

/** Streams raw model file bytes for the viewer/thumbnail renderer. Only serves files already indexed in the `files` table — never arbitrary paths. */
export function registerFileRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Params: { id: string; "*": string } }>(
    "/api/projects/:id/files/*",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid project id" });
      }

      const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const relativePath = request.params["*"];
      const fileRow = db
        .select()
        .from(filesTable)
        .where(and(eq(filesTable.projectId, id), eq(filesTable.relativePath, relativePath)))
        .get();
      if (!fileRow) {
        return reply.code(404).send({ error: "file not found" });
      }

      const projectRoot = resolve(project.path);
      const absolutePath = resolve(projectRoot, relativePath);
      if (absolutePath !== projectRoot && !absolutePath.startsWith(projectRoot + sep)) {
        return reply.code(400).send({ error: "invalid path" });
      }

      reply.header("Content-Type", CONTENT_TYPE_BY_EXTENSION[fileRow.extension] ?? "application/octet-stream");
      reply.header("Content-Length", fileRow.sizeBytes);
      reply.header("Cache-Control", "no-cache");
      return reply.send(createReadStream(absolutePath));
    },
  );
}
