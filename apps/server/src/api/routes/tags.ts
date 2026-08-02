import type { TagWithCount } from "@model-hub/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { projectTags as projectTagsTable, projects as projectsTable, tags as tagsTable } from "../../db/schema.js";
import { deleteTagIfUnused, getOrCreateTag, InvalidTagNameError } from "../../lib/tags.js";

export function registerTagRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/tags", async () => {
    const rows: TagWithCount[] = db
      .select({
        id: tagsTable.id,
        name: tagsTable.name,
        projectCount: sql<number>`count(${projectTagsTable.projectId})`,
      })
      .from(tagsTable)
      .leftJoin(projectTagsTable, eq(projectTagsTable.tagId, tagsTable.id))
      .groupBy(tagsTable.id)
      .orderBy(tagsTable.name)
      .all();
    return rows;
  });

  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    "/api/projects/:id/tags",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid project id" });
      }

      const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const rawName = request.body?.name;
      if (!rawName) {
        return reply.code(400).send({ error: "name is required" });
      }

      let tag;
      try {
        tag = getOrCreateTag(db, rawName);
      } catch (err) {
        if (err instanceof InvalidTagNameError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }

      db.insert(projectTagsTable)
        .values({ projectId: id, tagId: tag.id })
        .onConflictDoNothing()
        .run();

      return reply.code(201).send({ id: tag.id, name: tag.name });
    },
  );

  app.delete<{ Params: { id: string; tagId: string } }>(
    "/api/projects/:id/tags/:tagId",
    async (request, reply) => {
      const id = Number(request.params.id);
      const tagId = Number(request.params.tagId);
      if (!Number.isInteger(id) || !Number.isInteger(tagId)) {
        return reply.code(400).send({ error: "invalid id" });
      }

      db.delete(projectTagsTable)
        .where(and(eq(projectTagsTable.projectId, id), eq(projectTagsTable.tagId, tagId)))
        .run();
      deleteTagIfUnused(db, tagId);

      return reply.code(204).send();
    },
  );
}
