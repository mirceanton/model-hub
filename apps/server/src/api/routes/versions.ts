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
import { findFileFolderClash, sanitizeUploadPath } from "../../lib/fs-utils.js";
import { roleSatisfies } from "../../lib/roles.js";
import {
  createUploadStaging,
  inspectTarget,
  moveIntoPlace,
  pruneEmptyParents,
  resolveModelPath,
} from "../../lib/upload-staging.js";
import { getModelDiff } from "../../lib/model-diff.js";
import { getActiveModel } from "../../lib/model-lookup.js";
import { InvalidCommitShaError } from "../../lib/project-pins.js";
import { uploadRateLimit } from "../../lib/rate-limit.js";
import { getHeadSha, getLog, restoreToCommit } from "../../sync/git.js";
import { runExclusive } from "../../sync/queue.js";
import { LOCAL_UPLOAD_IDENTITY, type ReconcileResult, reconcileModelCore } from "../../sync/reconcile.js";
import { maybeEnqueueThumbnail } from "../../thumbnails/trigger.js";
import {
  bulkResponseSchema,
  errorResponseSchema,
  errorResponseWithSkippedFilesSchema,
  modelDiffSchema,
  numericIdParamSchema,
} from "../schemas.js";

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
    await pruneEmptyParents(model.path, absolutePath);
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
  //
  // One request = one commit ("changeset"): any number of `files` parts
  // (added/replaced at their filename, which may be a relative path into a
  // subfolder — see fs-utils.ts's sanitizeUploadPath) plus any number of
  // `delete` fields (relative paths to remove; folders left empty are
  // pruned). File parts are streamed into a private
  // staging dir first (lib/upload-staging.ts), *outside* the model's
  // working tree and without holding its lock; everything is validated, and
  // only then — under the per-path lock — moved into place and committed.
  // So the watcher/scanner can never observe (and auto-commit) a
  // half-written upload, and a rejected request leaves the model untouched.
  //
  // `baseSha` (optional) makes the write conditional, for clients that
  // download, edit offline and push back (e.g. an agent via MCP): the
  // request is refused with 409 unless the model's HEAD — after first
  // committing any not-yet-synced on-disk edits, so those count as a
  // conflicting change too — still matches the commit the client started
  // from.
  app.post<{ Params: { id: string } }>(
    "/api/models/:id/upload",
    {
      config: { rateLimit: uploadRateLimit(config) },
      schema: {
        tags: ["files"],
        summary: "Upload a new version",
        description:
          "Multipart upload committed as ONE new version: zero or more `files` parts (model and/or " +
          "attachment files, added or replaced at the part's filename, which may be a relative path " +
          "like `parts/arm.stl` — missing folders are created), zero or more `delete` fields " +
          "(relative paths of files to remove in the same commit; requires the admin role), an " +
          "optional `message` field used as the git commit message, and an optional `baseSha` " +
          "field (the commit sha you started from, 7-40 hex chars) — when given, the request fails " +
          "with 409 if the model has changed since. At least one file or delete is required. " +
          "Returns the resulting `headSha`, usable as the next request's `baseSha`.",
        params: numericIdParamSchema,
        consumes: ["multipart/form-data"],
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              committed: { type: "boolean" },
              writtenFiles: { type: "array", items: { type: "string" } },
              deletedFiles: { type: "array", items: { type: "string" } },
              skippedFiles: { type: "array", items: { type: "string" } },
              headSha: { type: ["string", "null"] },
            },
            required: ["ok", "committed", "writtenFiles", "deletedFiles", "skippedFiles", "headSha"],
          },
          400: errorResponseWithSkippedFilesSchema,
          403: errorResponseSchema,
          404: {
            type: "object",
            properties: {
              error: { type: "string" },
              missingFiles: { type: "array", items: { type: "string" } },
            },
            required: ["error"],
          },
          409: {
            type: "object",
            properties: {
              error: { type: "string" },
              baseSha: { type: "string" },
              headSha: { type: ["string", "null"] },
            },
            required: ["error", "baseSha", "headSha"],
          },
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

      const staging = await createUploadStaging(model.path);
      try {
        let message: string | undefined;
        let baseSha: string | undefined;
        const deleteRequests: string[] = [];
        const writtenFiles: string[] = [];
        const skippedFiles: string[] = [];
        // Relative path in the model -> flat name of its staged copy (staged
        // flat, so the staging dir never needs the upload's folder structure).
        const stagedNames = new Map<string, string>();

        // preservePath: keep the client's "parts/arm.stl" instead of busboy's
        // default basename-only filename; sanitizeUploadPath validates it.
        for await (const part of request.parts({ preservePath: true })) {
          if (part.type === "file") {
            const safePath = sanitizeUploadPath(part.filename);
            if (!safePath) {
              part.file.resume(); // drain so the iterator can continue
              skippedFiles.push(part.filename);
              continue;
            }
            // A repeated path overwrites its earlier staged copy: last one wins.
            let stagedName = stagedNames.get(safePath);
            if (!stagedName) {
              stagedName = String(stagedNames.size);
              stagedNames.set(safePath, stagedName);
              writtenFiles.push(safePath);
            }
            await pipeline(part.file, createWriteStream(join(staging.dir, stagedName)));
          } else if (typeof part.value === "string") {
            if (part.fieldname === "message") message = part.value;
            else if (part.fieldname === "baseSha") baseSha = part.value.trim();
            else if (part.fieldname === "delete") deleteRequests.push(part.value);
          }
        }

        if (baseSha !== undefined && !/^[0-9a-f]{7,40}$/i.test(baseSha)) {
          return reply.code(400).send({ error: "baseSha must be a 7-40 character hex commit sha" });
        }

        const clash = findFileFolderClash(writtenFiles);
        if (clash) {
          return reply.code(400).send({ error: `'${clash}' is uploaded both as a file and as a folder` });
        }

        const deletes: Array<{ relativePath: string; absolutePath: string }> = [];
        for (const raw of deleteRequests) {
          const resolved = resolveModelPath(model.path, raw);
          if (!resolved) {
            return reply.code(400).send({ error: `invalid delete path: ${JSON.stringify(raw)}` });
          }
          if (deletes.some((d) => d.relativePath === resolved.relativePath)) continue;
          if (stagedNames.has(resolved.relativePath)) {
            return reply
              .code(400)
              .send({ error: `'${resolved.relativePath}' is both uploaded and deleted in the same request` });
          }
          deletes.push(resolved);
        }

        if (writtenFiles.length === 0 && deletes.length === 0) {
          return reply.code(400).send({
            error: "no valid model or attachment files (.stl/.3mf/.obj/.step/.stp/.png/.jpg/.jpeg/.webp/.gif/.pdf) were uploaded",
            skippedFiles,
          });
        }

        // Deleting is an admin-only action everywhere else in the app (see
        // CLAUDE.md's Roles section and the MCP delete_file tool), so an
        // upload that carries deletions is gated the same way rather than
        // becoming a side door around that rule.
        if (deletes.length > 0 && !(request.user && roleSatisfies(request.user.role, "admin"))) {
          return reply.code(403).send({ error: 'deleting files requires the "admin" role' });
        }

        const deletedFiles = deletes.map((d) => d.relativePath);
        const defaultMessageParts: string[] = [];
        if (writtenFiles.length > 0) defaultMessageParts.push(`Uploaded ${writtenFiles.join(", ")}`);
        if (deletedFiles.length > 0) {
          defaultMessageParts.push(`${writtenFiles.length > 0 ? "deleted" : "Deleted"} ${deletedFiles.join(", ")}`);
        }
        const commitMessage = message?.trim() || defaultMessageParts.join("; ");

        type ApplyOutcome =
          | { kind: "ok"; result: ReconcileResult; headSha: string | null }
          | { kind: "error"; error: string }
          | { kind: "conflict"; headSha: string | null }
          | { kind: "invalid"; error: string }
          | { kind: "missing"; missingFiles: string[] };

        const outcome = await runExclusive(model.path, async (): Promise<ApplyOutcome> => {
          if (baseSha !== undefined) {
            // Fold any on-disk edits nobody has committed yet into history
            // first (as auto-sync, same as the scanner would), so HEAD
            // reflects what's really there before comparing it.
            const pre = await reconcileModelCore(db, model);
            if (pre.status === "error") return { kind: "error", error: pre.error ?? "unknown error" };
            const headSha = await getHeadSha(model.path);
            if (!headSha || !headSha.toLowerCase().startsWith(baseSha.toLowerCase())) {
              return { kind: "conflict", headSha };
            }
          }

          // Everything is checked against the live tree before anything is
          // touched, so a bad request is refused whole, never half-applied.
          for (const relativePath of writtenFiles) {
            const target = await inspectTarget(model.path, relativePath);
            if (!target.ok) return { kind: "invalid", error: `cannot write '${relativePath}': ${target.reason}` };
            if (target.existing === "directory") {
              return { kind: "invalid", error: `cannot write '${relativePath}': a folder with that name exists` };
            }
          }
          const missingFiles: string[] = [];
          for (const d of deletes) {
            const target = await inspectTarget(model.path, d.relativePath);
            if (!target.ok) return { kind: "invalid", error: `cannot delete '${d.relativePath}': ${target.reason}` };
            if (target.existing !== "file") missingFiles.push(d.relativePath);
          }
          if (missingFiles.length > 0) return { kind: "missing", missingFiles };

          for (const relativePath of writtenFiles) {
            await moveIntoPlace(join(staging.dir, stagedNames.get(relativePath)!), join(model.path, relativePath));
          }
          for (const d of deletes) {
            await rm(d.absolutePath);
            await pruneEmptyParents(model.path, d.absolutePath);
          }

          const result = await reconcileModelCore(db, model, {
            identity: LOCAL_UPLOAD_IDENTITY,
            commitMessage,
          });
          if (result.status === "error") return { kind: "error", error: result.error ?? "unknown error" };
          return { kind: "ok", result, headSha: await getHeadSha(model.path) };
        });

        if (outcome.kind === "error") {
          return reply.code(500).send({ error: outcome.error });
        }
        if (outcome.kind === "conflict") {
          return reply.code(409).send({
            error: "model has changed since baseSha; re-download it, reapply your changes and retry",
            baseSha,
            headSha: outcome.headSha,
          });
        }
        if (outcome.kind === "invalid") {
          return reply.code(400).send({ error: outcome.error });
        }
        if (outcome.kind === "missing") {
          return reply.code(404).send({
            error: `file(s) to delete not found: ${outcome.missingFiles.join(", ")}`,
            missingFiles: outcome.missingFiles,
          });
        }

        maybeEnqueueThumbnail(db, model, outcome.result);
        return {
          ok: true,
          committed: outcome.result.committed,
          writtenFiles,
          deletedFiles,
          skippedFiles,
          headSha: outcome.headSha,
        };
      } finally {
        await staging.cleanup();
      }
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
