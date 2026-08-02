import { createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { projects as projectsTable } from "../../db/schema.js";
import { enqueueThumbnail } from "../../thumbnails/trigger.js";

export function registerThumbnailRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/thumbnail", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid project id" });
    }

    const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
    if (!project?.thumbnailPath) {
      return reply.code(404).send({ error: "no thumbnail for this project" });
    }

    const projectRoot = resolve(project.path);
    const absolutePath = resolve(projectRoot, project.thumbnailPath);
    if (absolutePath !== projectRoot && !absolutePath.startsWith(projectRoot + sep)) {
      return reply.code(400).send({ error: "invalid thumbnail path" });
    }

    reply.header("Content-Type", "image/png");
    reply.header("Cache-Control", "no-cache");
    return reply.send(createReadStream(absolutePath));
  });

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/thumbnail/regenerate",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid project id" });
      }

      const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }
      if (!project.primaryFilePath) {
        return reply.code(400).send({ error: "project has no primary file to render" });
      }

      db.update(projectsTable)
        .set({ thumbnailStatus: "pending" })
        .where(eq(projectsTable.id, id))
        .run();
      enqueueThumbnail(db, project);
      return reply.code(202).send({ ok: true, thumbnailStatus: "pending" });
    },
  );
}
