import type { Tag, TagWithCount } from "@model-hub/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { projectTags as projectTagsTable, projects as projectsTable, tags as tagsTable } from "../../db/schema.js";
import {
  DuplicateTagNameError,
  deleteTag,
  deleteTagIfUnused,
  getOrCreateTag,
  InvalidTagColorError,
  InvalidTagNameError,
  updateTag,
} from "../../lib/tags.js";

export function registerTagRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/tags", async () => {
    const rows: TagWithCount[] = db
      .select({
        id: tagsTable.id,
        name: tagsTable.name,
        color: tagsTable.color,
        projectCount: sql<number>`count(${projectTagsTable.projectId})`,
      })
      .from(tagsTable)
      .leftJoin(projectTagsTable, eq(projectTagsTable.tagId, tagsTable.id))
      .groupBy(tagsTable.id)
      .orderBy(tagsTable.name)
      .all();
    return rows;
  });

  app.post<{ Body: { name?: string } }>("/api/tags", async (request, reply) => {
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

    const result: Tag = { id: tag.id, name: tag.name, color: tag.color };
    return reply.code(201).send(result);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; color?: string } }>(
    "/api/tags/:id",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid tag id" });
      }

      const { name, color } = request.body ?? {};
      if (name === undefined && color === undefined) {
        return reply.code(400).send({ error: "name or color is required" });
      }

      let tag;
      try {
        tag = updateTag(db, id, { name, color });
      } catch (err) {
        if (
          err instanceof InvalidTagNameError ||
          err instanceof InvalidTagColorError ||
          err instanceof DuplicateTagNameError
        ) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }

      if (!tag) {
        return reply.code(404).send({ error: "tag not found" });
      }

      const result: Tag = { id: tag.id, name: tag.name, color: tag.color };
      return reply.code(200).send(result);
    },
  );

  app.delete<{ Params: { id: string } }>("/api/tags/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid tag id" });
    }

    const deleted = deleteTag(db, id);
    if (!deleted) {
      return reply.code(404).send({ error: "tag not found" });
    }

    return reply.code(204).send();
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

      return reply.code(201).send({ id: tag.id, name: tag.name, color: tag.color });
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
