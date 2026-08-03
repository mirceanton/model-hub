import type { Model, ModelDetail, Tag } from "@model-hub/shared";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import {
  files as filesTable,
  models as modelsTable,
  modelTags as modelTagsTable,
  tags as tagsTable,
  type ModelRow,
} from "../../db/schema.js";
import { getTagsForModel, getTagsForModels } from "../../lib/tags.js";
import { getLog } from "../../sync/git.js";

function toApiModel(row: ModelRow, tags: Tag[]): Model {
  return {
    id: row.id,
    fsId: row.fsId,
    path: row.path,
    title: row.title,
    description: row.description,
    primaryFilePath: row.primaryFilePath,
    thumbnailPath: row.thumbnailPath,
    thumbnailStatus: row.thumbnailStatus,
    lastSyncedCommitSha: row.lastSyncedCommitSha,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.getTime() : null,
    syncStatus: row.syncStatus,
    syncError: row.syncError,
    missingSince: row.missingSince ? row.missingSince.getTime() : null,
    favorite: row.favorite,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    tags,
  };
}

export function registerModelRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Querystring: { q?: string; tag?: string; favorite?: string } }>(
    "/api/models",
    async (request) => {
      let rows = db
        .select()
        .from(modelsTable)
        .orderBy(desc(modelsTable.favorite), asc(sql`lower(${modelsTable.title})`))
        .all();

      const needle = request.query.q?.trim().toLowerCase();
      if (needle) {
        rows = rows.filter((row) => row.title.toLowerCase().includes(needle));
      }

      const tagFilter = request.query.tag?.trim();
      if (tagFilter) {
        const matchingModelIds = new Set(
          db
            .select({ modelId: modelTagsTable.modelId })
            .from(modelTagsTable)
            .innerJoin(tagsTable, eq(modelTagsTable.tagId, tagsTable.id))
            .where(sql`lower(${tagsTable.name}) = lower(${tagFilter})`)
            .all()
            .map((r) => r.modelId),
        );
        rows = rows.filter((row) => matchingModelIds.has(row.id));
      }

      if (request.query.favorite === "true") {
        rows = rows.filter((row) => row.favorite);
      }

      const tagsByModel = getTagsForModels(
        db,
        rows.map((row) => row.id),
      );
      return rows.map((row) => toApiModel(row, tagsByModel.get(row.id) ?? []));
    },
  );

  app.get<{ Params: { id: string } }>("/api/models/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const row = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
    if (!row) {
      return reply.code(404).send({ error: "model not found" });
    }

    const fileRows = db.select().from(filesTable).where(eq(filesTable.modelId, id)).all();
    const gitLog = row.missingSince == null ? await getLog(row.path).catch(() => []) : [];

    const detail: ModelDetail = {
      ...toApiModel(row, getTagsForModel(db, id)),
      files: fileRows.map((f) => ({
        relativePath: f.relativePath,
        sizeBytes: f.sizeBytes,
        mtime: f.mtime.getTime(),
        extension: f.extension,
      })),
      gitLog,
    };
    return detail;
  });

  app.patch<{
    Params: { id: string };
    Body: { title?: string; description?: string; favorite?: boolean };
  }>("/api/models/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const row = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
    if (!row) {
      return reply.code(404).send({ error: "model not found" });
    }

    const { title, description, favorite } = request.body ?? {};
    if (title !== undefined && title.trim().length === 0) {
      return reply.code(400).send({ error: "title cannot be empty" });
    }

    const updated = db
      .update(modelsTable)
      .set({
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(favorite !== undefined ? { favorite } : {}),
        updatedAt: new Date(),
      })
      .where(eq(modelsTable.id, id))
      .returning()
      .get();

    return toApiModel(updated, getTagsForModel(db, id));
  });

  app.delete<{ Params: { id: string } }>("/api/models/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const row = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
    if (!row) {
      return reply.code(404).send({ error: "model not found" });
    }
    // Only ever removes DB bookkeeping for a model whose directory is
    // already gone — never touches disk. A present model would just get
    // rediscovered (with fresh, disconnected metadata) on the next scan,
    // which is confusing enough to be worth blocking outright.
    if (row.syncStatus !== "missing") {
      return reply.code(409).send({
        error: "only models whose directory is missing can be forgotten",
      });
    }

    db.delete(modelsTable).where(eq(modelsTable.id, id)).run();
    return reply.code(204).send();
  });
}
