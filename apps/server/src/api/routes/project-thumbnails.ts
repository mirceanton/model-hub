import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { projects as projectsTable } from "../../db/schema.js";

/**
 * Custom project thumbnails. Unlike a model's thumbnail (a PNG file living
 * next to the model's own git repo — see thumbnails.ts), a Project has no
 * filesystem of its own (CLAUDE.md's Projects section), so the image is
 * stored directly in the `projects` row (thumbnailImage/thumbnailMimeType).
 * When unset, the web app falls back to the auto-generated mosaic of pinned
 * models' thumbnails (project-thumbnail-mosaic.tsx).
 */
export function registerProjectThumbnailRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/thumbnail", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid project id" });
    }

    const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
    if (!project?.thumbnailImage || !project.thumbnailMimeType) {
      return reply.code(404).send({ error: "no custom thumbnail for this project" });
    }

    reply.header("Content-Type", project.thumbnailMimeType);
    reply.header("Cache-Control", "no-cache");
    return reply.send(project.thumbnailImage);
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/thumbnail", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid project id" });
    }

    const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const part = await request.file();
    if (!part || !part.mimetype.startsWith("image/")) {
      return reply.code(400).send({ error: "an image file is required" });
    }
    const image = await part.toBuffer();

    db.update(projectsTable)
      .set({ thumbnailImage: image, thumbnailMimeType: part.mimetype, updatedAt: new Date() })
      .where(eq(projectsTable.id, id))
      .run();

    return reply.code(200).send({ ok: true });
  });

  // Clears a custom thumbnail, reverting to the auto-generated mosaic.
  app.delete<{ Params: { id: string } }>("/api/projects/:id/thumbnail", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid project id" });
    }

    const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    db.update(projectsTable)
      .set({ thumbnailImage: null, thumbnailMimeType: null, updatedAt: new Date() })
      .where(eq(projectsTable.id, id))
      .run();

    return reply.code(204).send();
  });
}
