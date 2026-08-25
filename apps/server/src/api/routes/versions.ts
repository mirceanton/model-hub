import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Config } from "../../config.js";
import type { DbClient } from "../../db/client.js";
import { files as filesTable } from "../../db/schema.js";
import { sanitizeUploadFilename } from "../../lib/fs-utils.js";
import { getActiveModel } from "../../lib/model-lookup.js";
import { uploadRateLimit } from "../../lib/rate-limit.js";
import { getLog, restoreToCommit } from "../../sync/git.js";
import { runExclusive } from "../../sync/queue.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { maybeEnqueueThumbnail } from "../../thumbnails/trigger.js";

export function registerVersionRoutes(app: FastifyInstance, db: DbClient, config: Config): void {

  app.post<{ Params: { id: string } }>(
    "/api/models/:id/upload",
    { config: { rateLimit: uploadRateLimit(config) } },
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

  app.delete<{ Params: { id: string; "*": string } }>(
    "/api/models/:id/files/*",
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
      const fileRow = db
        .select()
        .from(filesTable)
        .where(and(eq(filesTable.modelId, id), eq(filesTable.relativePath, relativePath)))
        .get();
      if (!fileRow) {
        return reply.code(404).send({ error: "file not found" });
      }

      const modelRoot = resolve(model.path);
      const absolutePath = resolve(modelRoot, relativePath);
      if (absolutePath !== modelRoot && !absolutePath.startsWith(modelRoot + sep)) {
        return reply.code(400).send({ error: "invalid path" });
      }

      const result = await runExclusive(model.path, async () => {
        await rm(absolutePath);
        return reconcileModelCore(db, model, {
          identity: LOCAL_UPLOAD_IDENTITY,
          commitMessage: `Deleted ${relativePath}`,
        });
      });

      if (result.status === "error") {
        return reply.code(500).send({ error: result.error });
      }
      maybeEnqueueThumbnail(db, model, result);
      return { ok: true, committed: result.committed };
    },
  );
}
