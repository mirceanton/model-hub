import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  BulkResponse,
  BulkResult,
  Model,
  ModelBulkAction,
  ModelDetail,
  ModelsBulkRequest,
  Tag,
} from "@model-hub/shared";
import { classifyAttachmentExtension } from "@model-hub/shared";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../../auth/guard.js";
import type { Config } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import {
  files as filesTable,
  models as modelsTable,
  modelTags as modelTagsTable,
  type ModelRow,
} from "../../db/schema.js";
import { computeDuplicateModelMap, type DuplicateModelRef, getDuplicateModels } from "../../lib/duplicates.js";
import { getModelFileAggregates, getModelIdsWithExtension } from "../../lib/file-filters.js";
import {
  ensureMarkerId,
  MODEL_EXTENSIONS,
  sanitizeModelDirName,
  sanitizeUploadFilename,
  TRASH_DIRNAME,
} from "../../lib/fs-utils.js";
import { getActiveModel } from "../../lib/model-lookup.js";
import { uploadRateLimit } from "../../lib/rate-limit.js";
import { isValidHttpUrl } from "../../lib/source-url.js";
import {
  deleteTagIfUnused,
  getModelIdsWithAllTags,
  getOrCreateTag,
  getTagsForModel,
  getTagsForModels,
  InvalidTagNameError,
} from "../../lib/tags.js";
import { enqueueSourceSnapshot } from "../../source-snapshot/trigger.js";
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
    sourceUrl: row.sourceUrl,
    sourceSnapshotStatus: row.sourceSnapshotStatus,
    sourceSnapshotError: row.sourceSnapshotError,
    sourceSnapshotFetchedAt: row.sourceSnapshotFetchedAt ? row.sourceSnapshotFetchedAt.getTime() : null,
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

/**
 * Recoverable "delete": moves the model's entire directory (repo included,
 * plus the untouched .modelhub-id marker inside it) under
 * LIBRARY_ROOT/.trash/ instead of destroying it, and marks deletedAt
 * instead of dropping the DB row — see apps/server/src/api/routes/trash.ts
 * for restore/purge. Runs under the same per-path lock as sync so it can't
 * race an in-flight commit for this model. The DB mutation happens *inside*
 * the lock too (not after), and re-checks deletedAt on a fresh read first —
 * otherwise a second near-simultaneous delete for the same id (two tabs, a
 * naive retry, or one item in a bulk-delete batch racing a concurrent
 * single-item delete) could still see deletedAt=null, acquire the
 * (by-then-free) lock, and try to rename a path that's already been moved
 * away.
 *
 * The single DELETE route below and the bulk "delete" action both call this
 * exact function — no separate/simplified bulk reimplementation of the
 * trash-move — so both stay behaviorally identical by construction.
 *
 * Returns false if the model was already trashed (or vanished) by the time
 * the lock was acquired, true if this call actually moved it.
 */
async function trashModel(db: DbClient, libraryRoot: string, row: ModelRow): Promise<boolean> {
  const trashRoot = join(libraryRoot, TRASH_DIRNAME);
  const trashPath = join(trashRoot, `${row.fsId}-${Date.now()}`);

  return runExclusive(row.path, async () => {
    const fresh = db.select().from(modelsTable).where(eq(modelsTable.id, row.id)).get();
    if (!fresh || fresh.deletedAt != null) return false;

    await mkdir(trashRoot, { recursive: true });
    await rename(fresh.path, trashPath);

    db.update(modelsTable)
      .set({ path: trashPath, deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(modelsTable.id, row.id))
      .run();
    return true;
  });
}

const SORT_COLUMNS = {
  title: sql`lower(${modelsTable.title})`,
  createdAt: modelsTable.createdAt,
  lastSyncedAt: modelsTable.lastSyncedAt,
} as const;

/** Parses a query-string value as a non-negative integer, or undefined if missing/blank/invalid. */
function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export function registerModelRoutes(
  app: FastifyInstance,
  db: DbClient,
  libraryRoot: string,
  config: Config,
): void {
  app.get<{
    Querystring: {
      q?: string;
      // A single `?tag=foo` parses as a string; repeating it (`?tag=foo&tag=bar`)
      // parses as an array — Fastify's default querystring parser (fast-querystring)
      // does this for any repeated key, no custom parsing needed. All listed
      // tags must match (AND), not any one of them.
      tag?: string | string[];
      favorite?: string;
      // Matches a model having at least one tracked file (model file or
      // attachment, e.g. "obj" or "pdf") with this extension — see
      // lib/file-filters.ts's getModelIdsWithExtension.
      extension?: string;
      minSizeBytes?: string;
      maxSizeBytes?: string;
      minFiles?: string;
      maxFiles?: string;
      page?: string;
      perPage?: string;
      sort?: string;
      order?: string;
    };
  }>("/api/models", async (request) => {
    const sortField =
      request.query.sort === "createdAt" || request.query.sort === "lastSyncedAt"
        ? request.query.sort
        : "title";
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

    const tagFilters = (request.query.tag == null ? [] : ([request.query.tag].flat() as string[]))
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tagFilters.length > 0) {
      const matchingModelIds = getModelIdsWithAllTags(db, tagFilters);
      rows = rows.filter((row) => matchingModelIds.has(row.id));
    }

    if (request.query.favorite === "true") {
      rows = rows.filter((row) => row.favorite);
    }

    const extensionFilter = request.query.extension?.trim().toLowerCase();
    if (extensionFilter) {
      const matchingModelIds = getModelIdsWithExtension(db, extensionFilter);
      rows = rows.filter((row) => matchingModelIds.has(row.id));
    }

    const minSizeBytes = parseNonNegativeInt(request.query.minSizeBytes);
    const maxSizeBytes = parseNonNegativeInt(request.query.maxSizeBytes);
    const minFiles = parseNonNegativeInt(request.query.minFiles);
    const maxFiles = parseNonNegativeInt(request.query.maxFiles);
    if (minSizeBytes !== undefined || maxSizeBytes !== undefined || minFiles !== undefined || maxFiles !== undefined) {
      const aggregates = getModelFileAggregates(db);
      rows = rows.filter((row) => {
        const agg = aggregates.get(row.id) ?? { totalSizeBytes: 0, fileCount: 0 };
        if (minSizeBytes !== undefined && agg.totalSizeBytes < minSizeBytes) return false;
        if (maxSizeBytes !== undefined && agg.totalSizeBytes > maxSizeBytes) return false;
        if (minFiles !== undefined && agg.fileCount < minFiles) return false;
        if (maxFiles !== undefined && agg.fileCount > maxFiles) return false;
        return true;
      });
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
  app.post("/api/models", { config: { rateLimit: uploadRateLimit(config) } }, async (request, reply) => {
    let title: string | undefined;
    let sourceUrl: string | undefined;
    const tagNames: string[] = [];
    const writtenFiles: string[] = [];
    const skippedFiles: string[] = [];
    let dirPath: string | null = null;
    let validationError: string | null = null;

    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "title" && typeof part.value === "string") {
            title = part.value;
          } else if (part.fieldname === "tags" && typeof part.value === "string") {
            tagNames.push(part.value);
          } else if (part.fieldname === "sourceUrl" && typeof part.value === "string") {
            sourceUrl = part.value;
          }
          continue;
        }

        if (dirPath == null && validationError == null) {
          const trimmedTitle = title?.trim();
          const trimmedSourceUrl = sourceUrl?.trim();
          if (!trimmedTitle) {
            validationError = "title is required and must be sent before any files";
          } else if (trimmedSourceUrl && !isValidHttpUrl(trimmedSourceUrl)) {
            validationError = "sourceUrl must be a valid http(s) URL";
          } else {
            const base = sanitizeModelDirName(trimmedTitle);
            if (!base) {
              validationError = "title must contain at least one valid character";
            } else {
              dirPath = await pickModelDirPath(libraryRoot, db, base);
              await mkdir(dirPath, { recursive: true });
            }
          }
        }

        if (validationError != null) {
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

    if (validationError != null) {
      if (dirPath) await rm(dirPath, { recursive: true, force: true }).catch(() => {});
      return reply.code(400).send({ error: validationError });
    }

    // Attachments (images/pdf) may ride along with a new model, but can't
    // create one on their own — a model needs at least one mesh file to
    // sync/view/thumbnail.
    const hasModelFile = writtenFiles.some((name) =>
      MODEL_EXTENSIONS.has(extname(name).slice(1).toLowerCase()),
    );
    if (!dirPath || !hasModelFile) {
      if (dirPath) await rm(dirPath, { recursive: true, force: true }).catch(() => {});
      return reply.code(400).send({
        error: "at least one valid model file (.stl/.3mf/.obj) is required",
        skippedFiles,
      });
    }

    const trimmedSourceUrl = sourceUrl?.trim() || null;
    const now = new Date();
    let modelRow: ModelRow;
    try {
      const { id: fsId } = await ensureMarkerId(dirPath);
      modelRow = db
        .insert(modelsTable)
        .values({
          fsId,
          path: dirPath,
          title: title!.trim(),
          sourceUrl: trimmedSourceUrl,
          sourceSnapshotStatus: trimmedSourceUrl ? "pending" : "none",
          createdAt: now,
          updatedAt: now,
        })
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
    if (trimmedSourceUrl) {
      enqueueSourceSnapshot(db, updatedRow);
    }

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

    const allFiles = fileRows.map((f) => ({
      relativePath: f.relativePath,
      sizeBytes: f.sizeBytes,
      mtime: f.mtime.getTime(),
      extension: f.extension,
    }));
    // `files` (model .stl/.3mf/.obj files — viewer/primary-file candidates)
    // and `attachments` (images/pdf — see classifyAttachmentExtension) are
    // both drawn from the same `files` table, since the sync engine caches
    // both categories there; only the API response splits them.
    const files = allFiles.filter((f) => classifyAttachmentExtension(f.extension) === null);
    const attachments = allFiles.filter((f) => classifyAttachmentExtension(f.extension) !== null);

    const detail: ModelDetail = {
      ...toApiModel(row, getTagsForModel(db, id), getDuplicateModels(db, id)),
      files,
      attachments,
      gitLog,
      // Only on the detail response, not the list one (toApiModel) — same
      // reasoning as `files`/`gitLog`: potentially large, only needed when
      // actually viewing one model.
      sourceSnapshotHtml: row.sourceSnapshotHtml,
    };
    return detail;
  });

  app.patch<{
    Params: { id: string };
    Body: {
      title?: string;
      description?: string;
      favorite?: boolean;
      primaryFilePath?: string;
      sourceUrl?: string | null;
    };
  }>("/api/models/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const row = getActiveModel(db, id);
    if (!row) {
      return reply.code(404).send({ error: "model not found" });
    }

    const { title, description, favorite, primaryFilePath, sourceUrl } = request.body ?? {};
    if (title !== undefined && title.trim().length === 0) {
      return reply.code(400).send({ error: "title cannot be empty" });
    }

    // undefined: field omitted, leave sourceUrl untouched. null or "": clear
    // it. Non-empty string: must be a syntactically valid http(s) URL — the
    // SSRF-relevant checks (resolved-IP blocking) happen at fetch time in
    // source-snapshot/generate.ts, not here.
    const normalizedSourceUrl = sourceUrl === undefined ? undefined : sourceUrl?.trim() || null;
    if (normalizedSourceUrl != null && !isValidHttpUrl(normalizedSourceUrl)) {
      return reply.code(400).send({ error: "sourceUrl must be a valid http(s) URL" });
    }
    const sourceUrlChanged = normalizedSourceUrl !== undefined && normalizedSourceUrl !== row.sourceUrl;

    if (primaryFilePath !== undefined) {
      const fileRow = db
        .select({ relativePath: filesTable.relativePath, extension: filesTable.extension })
        .from(filesTable)
        .where(and(eq(filesTable.modelId, id), eq(filesTable.relativePath, primaryFilePath)))
        .get();
      if (!fileRow) {
        return reply.code(400).send({ error: "primaryFilePath does not match a known file for this model" });
      }
      // Attachments (images/pdf) are never valid viewer/thumbnail-source
      // candidates — same rule as fs-utils.ts's pickPrimaryFile, enforced
      // here too so a direct API call can't set one as primary even though
      // the UI only ever offers model files.
      if (!MODEL_EXTENSIONS.has(fileRow.extension)) {
        return reply.code(400).send({ error: "primaryFilePath must be a model file (.stl/.3mf/.obj)" });
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
        ...(normalizedSourceUrl !== undefined ? { sourceUrl: normalizedSourceUrl } : {}),
        // A changed sourceUrl (including clearing it) invalidates whatever
        // snapshot was fetched for the *previous* URL — drop it and, if
        // there's a new URL to fetch, mark it pending so the queued job
        // below has somewhere terminal to land it.
        ...(sourceUrlChanged
          ? {
              sourceSnapshotStatus: normalizedSourceUrl ? ("pending" as const) : ("none" as const),
              sourceSnapshotHtml: null,
              sourceSnapshotError: null,
              sourceSnapshotFetchedAt: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(modelsTable.id, id))
      .returning()
      .get();

    if (primaryFileChanged) {
      enqueueThumbnail(db, updated);
    }
    if (sourceUrlChanged && normalizedSourceUrl) {
      enqueueSourceSnapshot(db, updated);
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

    const trashed = await trashModel(db, libraryRoot, row);
    if (!trashed) {
      return reply.code(404).send({ error: "model not found" });
    }

    return reply.code(204).send();
  });

  // See CLAUDE.md / packages/shared/src/types.ts's BulkResponse doc comment
  // for the shape shared across every bulk endpoint in this app. Every
  // action here reuses the exact same per-item logic (and, for "delete",
  // the exact same trashModel helper) as its single-item route above.
  // Items are processed sequentially, not in parallel: better-sqlite3 is
  // synchronous/single-threaded anyway, and this keeps one slow/failing
  // item from racing another's runExclusive lock in confusing ways.
  //
  // Gated behind requireRole("editor") even though none of the single-item
  // routes it batches are gated yet (see auth/guard.ts's comment: the RBAC
  // sweep was deliberately deferred to follow-up PRs that touch those
  // routes anyway — this bulk PR is exactly such a PR). Gating is warranted
  // here specifically because a bulk mutation is qualitatively more
  // dangerous than a single-item one — one confirm click can delete dozens
  // of models at once — so it doesn't inherit the single-item routes'
  // "ungated for now" pass.
  app.post<{ Body: ModelsBulkRequest }>(
    "/api/models/bulk",
    { preHandler: requireRole("editor") },
    async (request, reply) => {
      const { ids, action, tagName, tagId } = request.body ?? ({} as ModelsBulkRequest);
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
        return reply.code(400).send({ error: "ids must be a non-empty array of model ids" });
      }
      const validActions: ModelBulkAction[] = [
        "delete",
        "favorite",
        "unfavorite",
        "add-tag",
        "remove-tag",
      ];
      if (!validActions.includes(action)) {
        return reply.code(400).send({ error: `action must be one of: ${validActions.join(", ")}` });
      }

      // Whole-request (not per-item) validation for action-specific
      // parameters — these describe the batch itself, not any one item, so a
      // problem here means the request is malformed, not that a particular
      // model failed.
      let resolvedTag: { id: number } | null = null;
      if (action === "add-tag") {
        if (!tagName) {
          return reply.code(400).send({ error: "tagName is required for the add-tag action" });
        }
        try {
          resolvedTag = getOrCreateTag(db, tagName);
        } catch (err) {
          if (err instanceof InvalidTagNameError) {
            return reply.code(400).send({ error: err.message });
          }
          throw err;
        }
      } else if (action === "remove-tag") {
        if (typeof tagId !== "number" || !Number.isInteger(tagId)) {
          return reply.code(400).send({ error: "tagId is required for the remove-tag action" });
        }
      }

      const results: BulkResult[] = [];
      for (const id of ids) {
        const row = getActiveModel(db, id);
        if (!row) {
          results.push({ id, success: false, error: "model not found" });
          continue;
        }

        try {
          if (action === "delete") {
            const trashed = await trashModel(db, libraryRoot, row);
            results.push(
              trashed ? { id, success: true } : { id, success: false, error: "model not found" },
            );
          } else if (action === "favorite" || action === "unfavorite") {
            db.update(modelsTable)
              .set({ favorite: action === "favorite", updatedAt: new Date() })
              .where(eq(modelsTable.id, id))
              .run();
            results.push({ id, success: true });
          } else if (action === "add-tag") {
            db.insert(modelTagsTable)
              .values({ modelId: id, tagId: resolvedTag!.id })
              .onConflictDoNothing()
              .run();
            results.push({ id, success: true });
          } else {
            // remove-tag
            db.delete(modelTagsTable)
              .where(and(eq(modelTagsTable.modelId, id), eq(modelTagsTable.tagId, tagId!)))
              .run();
            results.push({ id, success: true });
          }
        } catch (err) {
          results.push({ id, success: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (action === "remove-tag" && typeof tagId === "number") {
        deleteTagIfUnused(db, tagId);
      }

      const response: BulkResponse = { results };
      return response;
    },
  );
}
