import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Model, ModelDetail, Tag } from "@model-hub/shared";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import {
  files as filesTable,
  models as modelsTable,
  modelTags as modelTagsTable,
  tags as tagsTable,
  type ModelRow,
} from "../../db/schema.js";
import { computeDuplicateModelMap, type DuplicateModelRef, getDuplicateModels } from "../../lib/duplicates.js";
import { ensureMarkerId, sanitizeModelDirName, sanitizeUploadFilename, TRASH_DIRNAME } from "../../lib/fs-utils.js";
import { getActiveModel } from "../../lib/model-lookup.js";
import { getOrCreateTag, getTagsForModel, getTagsForModels, InvalidTagNameError } from "../../lib/tags.js";
import { getLog } from "../../sync/git.js";
import { runExclusive } from "../../sync/queue.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { enqueueThumbnail, maybeEnqueueThumbnail } from "../../thumbnails/trigger.js";

export function toApiModel(row: ModelRow, tags: Tag[], duplicateModels: DuplicateModelRef[] = []): Model {
  return {
    id: row.id,
    fsId: row.fsId,
    path: row.path,
    title: row.title,
    description: row.description,
    primaryFilePath: row.primaryFilePath,
    thumbnailPath: row.thumbnailPath,
    thumbnailStatus: row.thumbnailStatus,
    thumbnailSource: row.thumbnailSource,
    lastSyncedCommitSha: row.lastSyncedCommitSha,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.getTime() : null,
    syncStatus: row.syncStatus,
    syncError: row.syncError,
    missingSince: row.missingSince ? row.missingSince.getTime() : null,
    favorite: row.favorite,
    deletedAt: row.deletedAt ? row.deletedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    tags,
    duplicateModels,
  };
}

/** Finds a directory name under libraryRoot not already used on disk or by another model row, appending " (2)", " (3)", ... on collision. */
export async function pickModelDirPath(libraryRoot: string, db: DbClient, base: string): Promise<string> {
  let candidateName = base;
  for (let suffix = 2; ; suffix++) {
    const candidatePath = join(libraryRoot, candidateName);
    const existsOnDisk = await stat(candidatePath)
      .then(() => true)
      .catch(() => false);
    const existsInDb =
      db.select({ id: modelsTable.id }).from(modelsTable).where(eq(modelsTable.path, candidatePath)).get() !=
      null;
    if (!existsOnDisk && !existsInDb) return candidatePath;
    candidateName = `${base} (${suffix})`;
  }
}

const SORT_COLUMNS = {
  title: sql`lower(${modelsTable.title})`,
  createdAt: modelsTable.createdAt,
} as const;

export function registerModelRoutes(app: FastifyInstance, db: DbClient, libraryRoot: string): void {
  app.get<{
    Querystring: {
      q?: string;
      tag?: string;
      favorite?: string;
      page?: string;
      perPage?: string;
      sort?: string;
      order?: string;
    };
  }>("/api/models", async (request) => {
    const sortField = request.query.sort === "createdAt" ? "createdAt" : "title";
    const orderFn = request.query.order === "desc" ? desc : asc;

    let rows = db
      .select()
      .from(modelsTable)
      .where(isNull(modelsTable.deletedAt))
      .orderBy(orderFn(SORT_COLUMNS[sortField]))
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

    const total = rows.length;

    const perPage = Number(request.query.perPage);
    if (Number.isInteger(perPage) && perPage > 0) {
      const page = Math.max(1, Number(request.query.page) || 1);
      const offset = (page - 1) * perPage;
      rows = rows.slice(offset, offset + perPage);
    }

    const tagsByModel = getTagsForModels(
      db,
      rows.map((row) => row.id),
    );
    const duplicatesByModel = computeDuplicateModelMap(db);
    return {
      data: rows.map((row) =>
        toApiModel(row, tagsByModel.get(row.id) ?? [], duplicatesByModel.get(row.id) ?? []),
      ),
      total,
    };
  });

  // Client must send the "title" field before any "files" parts — the
  // library-root directory (derived from the title) has to exist before
  // uploaded files can be streamed into it.
  app.post("/api/models", async (request, reply) => {
    let title: string | undefined;
    const tagNames: string[] = [];
    const writtenFiles: string[] = [];
    const skippedFiles: string[] = [];
    let dirPath: string | null = null;
    let titleError: string | null = null;

    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "title" && typeof part.value === "string") {
            title = part.value;
          } else if (part.fieldname === "tags" && typeof part.value === "string") {
            tagNames.push(part.value);
          }
          continue;
        }

        if (dirPath == null && titleError == null) {
          const trimmedTitle = title?.trim();
          if (!trimmedTitle) {
            titleError = "title is required and must be sent before any files";
          } else {
            const base = sanitizeModelDirName(trimmedTitle);
            if (!base) {
              titleError = "title must contain at least one valid character";
            } else {
              dirPath = await pickModelDirPath(libraryRoot, db, base);
              await mkdir(dirPath, { recursive: true });
            }
          }
        }

        if (titleError != null) {
          part.file.resume();
          continue;
        }

        const safeName = sanitizeUploadFilename(part.filename);
        if (!safeName) {
          part.file.resume();
          skippedFiles.push(part.filename);
          continue;
        }
        const dest = join(dirPath!, safeName);
        await pipeline(part.file, createWriteStream(dest));
        writtenFiles.push(safeName);
      }
    } catch (err) {
      if (dirPath) await rm(dirPath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    if (titleError != null) {
      if (dirPath) await rm(dirPath, { recursive: true, force: true }).catch(() => {});
      return reply.code(400).send({ error: titleError });
    }

    if (!dirPath || writtenFiles.length === 0) {
      if (dirPath) await rm(dirPath, { recursive: true, force: true }).catch(() => {});
      return reply.code(400).send({
        error: "at least one valid model file (.stl/.3mf/.obj) is required",
        skippedFiles,
      });
    }

    const now = new Date();
    let modelRow: ModelRow;
    try {
      const { id: fsId } = await ensureMarkerId(dirPath);
      modelRow = db
        .insert(modelsTable)
        .values({ fsId, path: dirPath, title: title!.trim(), createdAt: now, updatedAt: now })
        .returning()
        .get();
    } catch (err) {
      await rm(dirPath, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    const result = await runExclusive(dirPath, () =>
      reconcileModelCore(db, modelRow, {
        identity: LOCAL_UPLOAD_IDENTITY,
        commitMessage: "Initial import",
      }),
    );

    for (const rawName of tagNames) {
      let tag;
      try {
        tag = getOrCreateTag(db, rawName);
      } catch (err) {
        if (err instanceof InvalidTagNameError) continue;
        throw err;
      }
      db.insert(modelTagsTable).values({ modelId: modelRow.id, tagId: tag.id }).onConflictDoNothing().run();
    }

    const updatedRow = db.select().from(modelsTable).where(eq(modelsTable.id, modelRow.id)).get()!;
    maybeEnqueueThumbnail(db, updatedRow, result);

    return reply
      .code(201)
      .send(toApiModel(updatedRow, getTagsForModel(db, modelRow.id), getDuplicateModels(db, modelRow.id)));
  });

  app.get<{ Params: { id: string } }>("/api/models/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const row = getActiveModel(db, id);
    if (!row) {
      return reply.code(404).send({ error: "model not found" });
    }

    const fileRows = db.select().from(filesTable).where(eq(filesTable.modelId, id)).all();
    const gitLog = row.missingSince == null ? await getLog(row.path).catch(() => []) : [];

    const detail: ModelDetail = {
      ...toApiModel(row, getTagsForModel(db, id), getDuplicateModels(db, id)),
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
    Body: { title?: string; description?: string; favorite?: boolean; primaryFilePath?: string };
  }>("/api/models/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const row = getActiveModel(db, id);
    if (!row) {
      return reply.code(404).send({ error: "model not found" });
    }

    const { title, description, favorite, primaryFilePath } = request.body ?? {};
    if (title !== undefined && title.trim().length === 0) {
      return reply.code(400).send({ error: "title cannot be empty" });
    }

    if (primaryFilePath !== undefined) {
      const fileRow = db
        .select({ relativePath: filesTable.relativePath })
        .from(filesTable)
        .where(and(eq(filesTable.modelId, id), eq(filesTable.relativePath, primaryFilePath)))
        .get();
      if (!fileRow) {
        return reply.code(400).send({ error: "primaryFilePath does not match a known file for this model" });
      }
    }

    const primaryFileChanged = primaryFilePath !== undefined && primaryFilePath !== row.primaryFilePath;

    const updated = db
      .update(modelsTable)
      .set({
        ...(title !== undefined ? { title: title.trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(favorite !== undefined ? { favorite } : {}),
        ...(primaryFilePath !== undefined ? { primaryFilePath } : {}),
        ...(primaryFileChanged
          ? { thumbnailStatus: "pending" as const, thumbnailSource: "auto" as const }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(modelsTable.id, id))
      .returning()
      .get();

    if (primaryFileChanged) {
      enqueueThumbnail(db, updated);
    }

    return toApiModel(updated, getTagsForModel(db, id), getDuplicateModels(db, id));
  });

  app.delete<{ Params: { id: string } }>("/api/models/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const row = getActiveModel(db, id);
    if (!row) {
      return reply.code(404).send({ error: "model not found" });
    }

    // Recoverable: moves the model's entire directory (repo included, plus
    // the untouched .modelhub-id marker inside it) under LIBRARY_ROOT/.trash/
    // instead of destroying it, and marks deletedAt instead of dropping the
    // DB row — see apps/server/src/api/routes/trash.ts for restore/purge.
    // Runs under the same per-path lock as sync so it can't race an
    // in-flight commit for this model. The DB mutation happens *inside* the
    // lock too (not after), and re-checks deletedAt on a fresh read first —
    // otherwise a second near-simultaneous DELETE for the same id (two
    // tabs, a naive retry) could still see deletedAt=null, acquire the
    // (by-then-free) lock, and try to rename a path that's already been
    // moved away.
    const trashRoot = join(libraryRoot, TRASH_DIRNAME);
    const trashPath = join(trashRoot, `${row.fsId}-${Date.now()}`);

    const trashed = await runExclusive(row.path, async () => {
      const fresh = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
      if (!fresh || fresh.deletedAt != null) return false;

      await mkdir(trashRoot, { recursive: true });
      await rename(fresh.path, trashPath);

      db.update(modelsTable)
        .set({ path: trashPath, deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(modelsTable.id, id))
        .run();
      return true;
    });

    if (!trashed) {
      return reply.code(404).send({ error: "model not found" });
    }

    return reply.code(204).send();
  });
}
