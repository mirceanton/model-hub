import { resolve, sep } from "node:path";
import { ZipArchive, type ArchiverError } from "archiver";
import { eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireRole } from "../../auth/guard.js";
import type { DbClient } from "../../db/client.js";
import { files as filesTable, models as modelsTable, type ModelRow } from "../../db/schema.js";
import { makeDirNamePicker, sanitizeModelDirName } from "../../lib/fs-utils.js";
import { getTagsForModel, getTagsForModels } from "../../lib/tags.js";

/**
 * The metadata sidecar included in every export below — lets a model's
 * title/description/tags/favorite status/last-synced commit survive
 * independent of the SQLite DB (issue #64), e.g. for offline backup or
 * re-importing into a fresh instance. Deliberately a plain data snapshot,
 * not anything the app itself ever reads back in — there's no import route
 * for it (out of scope for #64).
 */
interface ModelExportMetadata {
  modelId: number;
  title: string;
  description: string;
  tags: string[];
  favorite: boolean;
  lastSyncedCommitSha: string | null;
  fileCount: number;
}

/** One model's entry in a multi-model (or full-library) export's root manifest.json. */
interface ModelsExportManifestEntry extends ModelExportMetadata {
  /** The subdirectory this model's files were written under, inside the zip. */
  directory: string;
  /** Set (fileCount left at 0) when the requested model id didn't resolve to any model — e.g. hard-deleted since it was selected. The rest of the export still proceeds. */
  exportError: string | null;
}

interface ModelsExportManifest {
  exportedAt: string;
  models: ModelsExportManifestEntry[];
}

function buildMetadata(db: DbClient, row: ModelRow, fileCount: number): ModelExportMetadata {
  return {
    modelId: row.id,
    title: row.title,
    description: row.description,
    tags: getTagsForModel(db, row.id).map((t) => t.name),
    favorite: row.favorite,
    lastSyncedCommitSha: row.lastSyncedCommitSha,
    fileCount,
  };
}

/**
 * Appends every one of a model's currently-indexed files (the `files` DB
 * cache — same source of truth GET /api/models/:id/download reads) into
 * `archive` under `prefix` ("" for a flat single-model export, a
 * per-model subdirectory for a multi-model one). Streams straight off disk
 * via archive.file() — never buffers a whole file (let alone the whole zip)
 * in memory, same as download.ts/project-export.ts. Returns the file count
 * actually appended (paths that would escape the model's own directory are
 * silently skipped, same guard as download.ts).
 */
function appendModelFiles(db: DbClient, archive: ZipArchive, row: ModelRow, prefix: string): number {
  const modelFiles = db.select().from(filesTable).where(eq(filesTable.modelId, row.id)).all();
  const modelRoot = resolve(row.path);
  let count = 0;
  for (const file of modelFiles) {
    const absolutePath = resolve(modelRoot, file.relativePath);
    if (absolutePath !== modelRoot && !absolutePath.startsWith(modelRoot + sep)) continue;
    archive.file(absolutePath, { name: `${prefix}${file.relativePath}` });
    count++;
  }
  return count;
}

/** Shared response setup for every export route below: zip headers + archiver warning/error logging. */
function startZipResponse(
  archive: ZipArchive,
  filenameBase: string,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  archive.on("warning", (err: ArchiverError) => request.log.warn(err));
  archive.on("error", (err: ArchiverError) => request.log.error(err));
  reply.header("Content-Type", "application/zip");
  reply.header("Content-Disposition", `attachment; filename="${filenameBase}.zip"`);
}

/**
 * Export endpoints (issue #64) — distinct from GET /api/models/:id/download
 * (download.ts), which zips a model's files with no metadata. Every export
 * here also writes a metadata.json/manifest.json sidecar (title,
 * description, tags, favorite, lastSyncedCommitSha) so a model's metadata
 * survives independent of the SQLite DB, e.g. for backup.
 *
 * Trashed models: reachable by explicit id (both the single-model GET and
 * the multi-model POST use an unfiltered lookup, not getActiveModel) — same
 * reasoning as project-export.ts's pin export: a trashed model's directory
 * is still physically present under LIBRARY_ROOT/.trash/ until purge, and
 * exporting it (e.g. right before the retention window purges it, or
 * without first restoring it) is a reasonable thing to want. Only a
 * hard-deleted model has nothing left to export, which surfaces as a 404
 * (single) or a per-item exportError in the manifest (multi). The
 * full-library export is the one export that's deliberately unfiltered-*to*
 * active-only (isNull(deletedAt)) — "the library" excludes models on their
 * way out, matching CLAUDE.md's Trash convention for every other
 * "whole library" view.
 */
export function registerModelExportRoutes(app: FastifyInstance, db: DbClient): void {
  // Registered before the POST/GET "/api/models/export" routes below only
  // for readability grouping (single -> selected -> all); route order
  // doesn't actually matter here since "/api/models/export" is a fully
  // static path and "/api/models/:id/export" is parametric — Fastify's
  // router (find-my-way) always prefers the static match, so the two never
  // shadow each other regardless of registration order.
  app.get<{ Params: { id: string } }>("/api/models/:id/export", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const row = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
    if (!row) {
      return reply.code(404).send({ error: "model not found" });
    }

    const filenameBase = sanitizeModelDirName(row.title) ?? "model";
    const archive = new ZipArchive({ zlib: { level: 9 } });
    startZipResponse(archive, filenameBase, request, reply);

    const fileCount = appendModelFiles(db, archive, row, "");
    const metadata = buildMetadata(db, row, fileCount);
    archive.append(JSON.stringify(metadata, null, 2), { name: "metadata.json" });

    void archive.finalize();
    return reply.send(archive);
  });

  // POST (not GET) since the id list can be arbitrarily long — same
  // reasoning as every other .../bulk endpoint in this app taking its ids
  // in the body rather than the querystring.
  app.post<{ Body: { ids?: number[] } }>("/api/models/export", async (request, reply) => {
    const { ids } = request.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((modelId) => !Number.isInteger(modelId))) {
      return reply.code(400).send({ error: "ids must be a non-empty array of model ids" });
    }

    const rows: ModelRow[] = [];
    const missingIds: number[] = [];
    for (const modelId of ids) {
      const row = db.select().from(modelsTable).where(eq(modelsTable.id, modelId)).get();
      if (row) {
        rows.push(row);
      } else {
        missingIds.push(modelId);
      }
    }

    if (rows.length === 0) {
      return reply.code(404).send({ error: "none of the requested model ids were found" });
    }

    const archive = new ZipArchive({ zlib: { level: 9 } });
    startZipResponse(archive, "models", request, reply);

    const pickDirName = makeDirNamePicker();
    const manifest: ModelsExportManifest = { exportedAt: new Date().toISOString(), models: [] };

    const tagsByModel = getTagsForModels(db, rows.map((row) => row.id));
    for (const row of rows) {
      const directory = pickDirName(row.title, row.id);
      const fileCount = appendModelFiles(db, archive, row, `${directory}/`);
      manifest.models.push({
        modelId: row.id,
        title: row.title,
        description: row.description,
        tags: (tagsByModel.get(row.id) ?? []).map((t) => t.name),
        favorite: row.favorite,
        lastSyncedCommitSha: row.lastSyncedCommitSha,
        fileCount,
        directory,
        exportError: null,
      });
    }
    for (const missingId of missingIds) {
      manifest.models.push({
        modelId: missingId,
        title: "",
        description: "",
        tags: [],
        favorite: false,
        lastSyncedCommitSha: null,
        fileCount: 0,
        directory: "",
        exportError: "model not found",
      });
    }

    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

    void archive.finalize();
    return reply.send(archive);
  });

  // Admin-only (unlike single/multi export above): unlike exporting a few
  // models you explicitly picked, this dumps the entire library's file
  // contents over the network in one request — a meaningfully more
  // sensitive operation, same rationale CLAUDE.md/models.ts's bulk route
  // gives for gating bulk mutations behind a role, applied here to a bulk
  // *read*. Streams entry-by-entry via the same ZipArchive pattern as every
  // other export/download route in this file — archive.file() reads each
  // model's files off disk as the response streams out, never buffering the
  // whole (potentially library-sized) zip in memory.
  app.get("/api/models/export", { preHandler: requireRole("admin") }, async (request, reply) => {
    const rows = db.select().from(modelsTable).where(isNull(modelsTable.deletedAt)).all();

    const archive = new ZipArchive({ zlib: { level: 9 } });
    startZipResponse(archive, "library", request, reply);

    const pickDirName = makeDirNamePicker();
    const manifest: ModelsExportManifest = { exportedAt: new Date().toISOString(), models: [] };

    const tagsByModel = getTagsForModels(db, rows.map((row) => row.id));
    for (const row of rows) {
      const directory = pickDirName(row.title, row.id);
      const fileCount = appendModelFiles(db, archive, row, `${directory}/`);
      manifest.models.push({
        modelId: row.id,
        title: row.title,
        description: row.description,
        tags: (tagsByModel.get(row.id) ?? []).map((t) => t.name),
        favorite: row.favorite,
        lastSyncedCommitSha: row.lastSyncedCommitSha,
        fileCount,
        directory,
        exportError: null,
      });
    }

    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

    void archive.finalize();
    return reply.send(archive);
  });
}
