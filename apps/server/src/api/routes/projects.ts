import type { Project, ProjectDetail } from "@model-hub/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { files as filesTable, projects as projectsTable, type ProjectRow } from "../../db/schema.js";
import { getLog } from "../../sync/git.js";

function toApiProject(row: ProjectRow): Project {
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
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function registerProjectRoutes(app: FastifyInstance, db: DbClient): void {
  app.get("/api/projects", async () => {
    const rows = db.select().from(projectsTable).all();
    return rows.map(toApiProject);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid project id" });
    }

    const row = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
    if (!row) {
      return reply.code(404).send({ error: "project not found" });
    }

    const fileRows = db.select().from(filesTable).where(eq(filesTable.projectId, id)).all();
    const gitLog = row.missingSince == null ? await getLog(row.path).catch(() => []) : [];

    const detail: ProjectDetail = {
      ...toApiProject(row),
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
}
