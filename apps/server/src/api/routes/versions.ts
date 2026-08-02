import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { projects as projectsTable } from "../../db/schema.js";
import { sanitizeUploadFilename } from "../../lib/fs-utils.js";
import { getLog, restoreToCommit } from "../../sync/git.js";
import { runExclusive } from "../../sync/queue.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileProjectCore } from "../../sync/reconcile.js";

const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024; // 1GB — generous for large/multi-plate sliced files

export function registerVersionRoutes(app: FastifyInstance, db: DbClient): void {
  app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_FILE_BYTES },
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/upload", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid project id" });
    }

    const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
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
        const dest = join(project.path, safeName);
        await pipeline(part.file, createWriteStream(dest));
        writtenFiles.push(safeName);
      } else if (part.fieldname === "message" && typeof part.value === "string") {
        message = part.value;
      }
    }

    if (writtenFiles.length === 0) {
      return reply.code(400).send({
        error: "no valid model files (.stl/.3mf) were uploaded",
        skippedFiles,
      });
    }

    const commitMessage = message?.trim() || `Uploaded ${writtenFiles.join(", ")}`;
    const result = await runExclusive(project.path, () =>
      reconcileProjectCore(db, project, {
        identity: LOCAL_UPLOAD_IDENTITY,
        commitMessage,
      }),
    );

    if (result.status === "error") {
      return reply.code(500).send({ error: result.error });
    }
    return { ok: true, committed: result.committed, writtenFiles, skippedFiles };
  });

  app.post<{ Params: { id: string }; Body: { sha?: string } }>(
    "/api/projects/:id/restore",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid project id" });
      }

      const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const sha = request.body?.sha;
      if (!sha) {
        return reply.code(400).send({ error: "sha is required" });
      }

      const log = await getLog(project.path);
      const target = log.find((entry) => entry.sha === sha);
      if (!target) {
        return reply.code(400).send({ error: "sha is not a known commit for this project" });
      }

      const result = await runExclusive(project.path, async () => {
        await restoreToCommit(project.path, sha);
        return reconcileProjectCore(db, project, {
          identity: LOCAL_UPLOAD_IDENTITY,
          commitMessage: `Restored to ${sha.slice(0, 10)}: ${target.message}`,
        });
      });

      if (result.status === "error") {
        return reply.code(500).send({ error: result.error });
      }
      return { ok: true, committed: result.committed };
    },
  );
}
