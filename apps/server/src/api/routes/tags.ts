import type { Tag, TagWithCount } from "@model-hub/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { modelTags as modelTagsTable, models as modelsTable, tags as tagsTable } from "../../db/schema.js";
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
    // The second leftJoin's ON clause (not a WHERE) is what lets a trashed
    // model's row disappear from the count while the tag itself, and its
    // count of any *other* (non-trashed) models, still show up: a failed
    // join condition nulls out modelsTable.id for that row without dropping
    // it, and count() ignores nulls — counting modelTagsTable.modelId instead
    // would still count every trashed association.
    const rows: TagWithCount[] = db
      .select({
        id: tagsTable.id,
        name: tagsTable.name,
        color: tagsTable.color,
        modelCount: sql<number>`count(${modelsTable.id})`,
      })
      .from(tagsTable)
      .leftJoin(modelTagsTable, eq(modelTagsTable.tagId, tagsTable.id))
      .leftJoin(
        modelsTable,
        and(eq(modelsTable.id, modelTagsTable.modelId), isNull(modelsTable.deletedAt)),
      )
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
    "/api/models/:id/tags",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid model id" });
      }

      const model = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
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

      db.insert(modelTagsTable)
        .values({ modelId: id, tagId: tag.id })
        .onConflictDoNothing()
        .run();

      return reply.code(201).send({ id: tag.id, name: tag.name, color: tag.color });
    },
  );

  app.delete<{ Params: { id: string; tagId: string } }>(
    "/api/models/:id/tags/:tagId",
    async (request, reply) => {
      const id = Number(request.params.id);
      const tagId = Number(request.params.tagId);
      if (!Number.isInteger(id) || !Number.isInteger(tagId)) {
        return reply.code(400).send({ error: "invalid id" });
      }

      db.delete(modelTagsTable)
        .where(and(eq(modelTagsTable.modelId, id), eq(modelTagsTable.tagId, tagId)))
        .run();
      deleteTagIfUnused(db, tagId);

      return reply.code(204).send();
    },
  );
}
