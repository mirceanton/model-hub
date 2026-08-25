import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { BulkResponse, BulkResult, ModelFilesBulkRequest } from "@model-hub/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../../auth/guard.js";
import type { Config } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import { files as filesTable, type ModelRow } from "../../db/schema.js";
import { sanitizeUploadFilename } from "../../lib/fs-utils.js";
import { getModelDiff } from "../../lib/model-diff.js";
import { getActiveModel } from "../../lib/model-lookup.js";
import { InvalidCommitShaError } from "../../lib/project-pins.js";
import { uploadRateLimit } from "../../lib/rate-limit.js";
import { getLog, restoreToCommit } from "../../sync/git.js";
import { runExclusive } from "../../sync/queue.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { maybeEnqueueThumbnail } from "../../thumbnails/trigger.js";
import { bulkResponseSchema, errorResponseSchema, modelDiffSchema, numericIdParamSchema } from "../schemas.js";

type DeleteFileOutcome =
  | { ok: true; committed: boolean }
  | { ok: false; status: 400 | 404 | 500; error: string };

/**
 * The single-file-delete logic — validates the file is known and its path
 * stays within the model's directory, deletes it, and reconciles (new
 * commit) under the same per-path `runExclusive` lock sync uses. Shared by
 * the single DELETE route and the bulk-delete action below so both stay
 * behaviorally identical by construction, same reasoning as
 * models.ts's trashModel.
 */
async function deleteSingleFile(
  db: DbClient,
  model: ModelRow,
  relativePath: string,
): Promise<DeleteFileOutcome> {
  const fileRow = db
    .select()
    .from(filesTable)
    .where(and(eq(filesTable.modelId, model.id), eq(filesTable.relativePath, relativePath)))
    .get();
  if (!fileRow) {
    return { ok: false, status: 404, error: "file not found" };
  }

  const modelRoot = resolve(model.path);
  const absolutePath = resolve(modelRoot, relativePath);
  if (absolutePath !== modelRoot && !absolutePath.startsWith(modelRoot + sep)) {
    return { ok: false, status: 400, error: "invalid path" };
  }

  const result = await runExclusive(model.path, async () => {
    await rm(absolutePath);
    return reconcileModelCore(db, model, {
      identity: LOCAL_UPLOAD_IDENTITY,
      commitMessage: `Deleted ${relativePath}`,
    });
  });

  if (result.status === "error") {
    return { ok: false, status: 500, error: result.error ?? "unknown error" };
  }
  maybeEnqueueThumbnail(db, model, result);
  return { ok: true, committed: result.committed };
}

export function registerVersionRoutes(app: FastifyInstance, db: DbClient, config: Config): void {

  // No `body` schema: multipart/form-data consumed field-by-field via
  // `request.parts()` (see models.ts's create-model route for the same
  // reasoning), so `request.body` is never populated for Fastify to
  // validate against.
  app.post<{ Params: { id: string } }>(
    "/api/models/:id/upload",
    {
      config: { rateLimit: uploadRateLimit(config) },
      schema: {
        tags: ["files"],
        summary: "Upload a new version",
        description:
          "Multipart upload: one or more `files` parts (model and/or attachment files) plus " +
          "an optional `message` field used as the git commit message.",
        params: numericIdParamSchema,
        consumes: ["multipart/form-data"],
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              committed: { type: "boolean" },
              writtenFiles: { type: "array", items: { type: "string" } },
              skippedFiles: { type: "array", items: { type: "string" } },
            },
            required: ["ok", "committed", "writtenFiles", "skippedFiles"],
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid model id" });
      }

      const model = getActiveModel(db, id);
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }

      let message: string | undefined;
      const writtenFiles: string[] = [];
      const skippedFiles: string[] = [];

      for await (const part of request.parts()) {
        if (part.type === "file") {
          const safeName = sanitizeUploadFilename(part.filename);
          if (!safeName) {
            part.file.resume(); // drain so the iterator can continue
            skippedFiles.push(part.filename);
            continue;
          }
          const dest = join(model.path, safeName);
          await pipeline(part.file, createWriteStream(dest));
          writtenFiles.push(safeName);
        } else if (part.fieldname === "message" && typeof part.value === "string") {
          message = part.value;
        }
      }

      if (writtenFiles.length === 0) {
        return reply.code(400).send({
          error: "no valid model or attachment files (.stl/.3mf/.obj/.png/.jpg/.jpeg/.webp/.gif/.pdf) were uploaded",
          skippedFiles,
        });
      }

      const commitMessage = message?.trim() || `Uploaded ${writtenFiles.join(", ")}`;
      const result = await runExclusive(model.path, () =>
        reconcileModelCore(db, model, {
          identity: LOCAL_UPLOAD_IDENTITY,
          commitMessage,
        }),
      );

      if (result.status === "error") {
        return reply.code(500).send({ error: result.error });
      }
      maybeEnqueueThumbnail(db, model, result);
      return { ok: true, committed: result.committed, writtenFiles, skippedFiles };
    },
  );

  app.post<{ Params: { id: string }; Body: { sha?: string } }>(
    "/api/models/:id/restore",
    {
      schema: {
        tags: ["files"],
        summary: "Restore to a previous commit",
        params: numericIdParamSchema,
        body: {
          type: "object",
          properties: { sha: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: { ok: { type: "boolean" }, committed: { type: "boolean" } },
            required: ["ok", "committed"],
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid model id" });
      }

      const model = getActiveModel(db, id);
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }

      const sha = request.body?.sha;
      if (!sha) {
        return reply.code(400).send({ error: "sha is required" });
      }

      const log = await getLog(model.path);
      const target = log.find((entry) => entry.sha === sha);
      if (!target) {
        return reply.code(400).send({ error: "sha is not a known commit for this model" });
      }

      const result = await runExclusive(model.path, async () => {
        await restoreToCommit(model.path, sha);
        return reconcileModelCore(db, model, {
          identity: LOCAL_UPLOAD_IDENTITY,
          commitMessage: `Restored to ${sha.slice(0, 10)}: ${target.message}`,
        });
      });

      if (result.status === "error") {
        return reply.code(500).send({ error: result.error });
      }
      maybeEnqueueThumbnail(db, model, result);
      return { ok: true, committed: result.committed };
    },
  );

  // Generically useful beyond the Projects pin-bump flow (e.g. "what changed
  // since I last looked at this model's history"), so this lives at the
  // model level rather than under /api/projects — see issue #68. Uses
  // getActiveModel (not the unfiltered lookup #67's project export route
  // uses): unlike export, there's no data-preservation motive for reaching a
  // trashed model here, and the one caller that exists today (the pin-bump
  // UI) already requires an active model for the PATCH it previews, since
  // /api/projects/:id/pins/:modelId itself 404s on a trashed model. This
  // follows the stricter convention most "normal" model routes use (see
  // lib/model-lookup.ts), same as this model's own gitLog on GET
  // /api/models/:id.
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    "/api/models/:id/diff",
    {
      schema: {
        tags: ["files"],
        summary: "Diff two commits",
        params: numericIdParamSchema,
        querystring: {
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
        },
        response: {
          200: modelDiffSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid model id" });
      }

      const model = getActiveModel(db, id);
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }

      const { from, to } = request.query;
      if (!from || !to) {
        return reply.code(400).send({ error: "from and to are required" });
      }

      try {
        return await getModelDiff(model.path, from, to);
      } catch (err) {
        if (err instanceof InvalidCommitShaError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; "*": string } }>(
    "/api/models/:id/files/*",
    {
      schema: {
        tags: ["files"],
        summary: "Delete one file",
        description: "The `*` wildcard is the file's path relative to the model directory.",
        response: {
          200: {
            type: "object",
            properties: { ok: { type: "boolean" }, committed: { type: "boolean" } },
            required: ["ok", "committed"],
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid model id" });
      }

      const model = getActiveModel(db, id);
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }

      const relativePath = request.params["*"];
      const outcome = await deleteSingleFile(db, model, relativePath);
      if (!outcome.ok) {
        return reply.code(outcome.status).send({ error: outcome.error });
      }
      return { ok: true, committed: outcome.committed };
    },
  );

  // See packages/shared/src/types.ts's BulkResponse doc comment for the
  // shape shared across every bulk endpoint in this app. `ids` are
  // relativePaths (not URL-encoded — this is a JSON body, not a URL path
  // segment). Reuses deleteSingleFile for every item, one at a time, so a
  // bulk delete is byte-for-byte the same per-item behavior (including the
  // per-path runExclusive lock and the one-commit-per-file history) as
  // calling the single DELETE route N times — just with per-item results
  // instead of the caller having to fire N requests and stitch failures
  // together itself.
  //
  // Gated behind requireRole("editor") — see models.ts's POST
  // /api/models/bulk for the same reasoning (a bulk delete is qualitatively
  // more dangerous than deleting one file at a time, and this PR is the
  // "follow-up PR that touches this route" auth/guard.ts's comment refers
  // to). The single-file DELETE route above stays ungated for now, matching
  // every other still-ungated single-item route.
  app.post<{ Params: { id: string }; Body: ModelFilesBulkRequest }>(
    "/api/models/:id/files/bulk",
    {
      preHandler: requireRole("editor"),
      schema: {
        tags: ["files"],
        summary: "Bulk-delete files",
        params: numericIdParamSchema,
        body: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" }, minItems: 1 },
            action: { type: "string", enum: ["delete"] },
          },
          required: ["ids", "action"],
        },
        response: {
          200: bulkResponseSchema("string"),
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid model id" });
      }

      const model = getActiveModel(db, id);
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }

      const { ids, action } = request.body ?? ({} as ModelFilesBulkRequest);
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((p) => typeof p !== "string" || !p)) {
        return reply.code(400).send({ error: "ids must be a non-empty array of relative file paths" });
      }
      if (action !== "delete") {
        return reply.code(400).send({ error: 'action must be "delete"' });
      }

      const results: BulkResult<string>[] = [];
      for (const relativePath of ids) {
        const outcome = await deleteSingleFile(db, model, relativePath);
        results.push(
          outcome.ok ? { id: relativePath, success: true } : { id: relativePath, success: false, error: outcome.error },
        );
      }

      const response: BulkResponse<string> = { results };
      return response;
    },
  );
}
