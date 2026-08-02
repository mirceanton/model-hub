import type { Project, ProjectDetail, Tag } from "@model-hub/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import {
  files as filesTable,
  projects as projectsTable,
  projectTags as projectTagsTable,
  tags as tagsTable,
  type ProjectRow,
} from "../../db/schema.js";
import { getTagsForProject, getTagsForProjects } from "../../lib/tags.js";
import { getLog } from "../../sync/git.js";

function toApiProject(row: ProjectRow, tags: Tag[]): Project {
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
    tags,
  };
}

export function registerProjectRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Querystring: { q?: string; tag?: string } }>("/api/projects", async (request) => {
    let rows = db.select().from(projectsTable).all();

    const needle = request.query.q?.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((row) => row.title.toLowerCase().includes(needle));
    }

    const tagFilter = request.query.tag?.trim();
    if (tagFilter) {
      const matchingProjectIds = new Set(
        db
          .select({ projectId: projectTagsTable.projectId })
          .from(projectTagsTable)
          .innerJoin(tagsTable, eq(projectTagsTable.tagId, tagsTable.id))
          .where(sql`lower(${tagsTable.name}) = lower(${tagFilter})`)
          .all()
          .map((r) => r.projectId),
      );
      rows = rows.filter((row) => matchingProjectIds.has(row.id));
    }

    const tagsByProject = getTagsForProjects(
      db,
      rows.map((row) => row.id),
    );
    return rows.map((row) => toApiProject(row, tagsByProject.get(row.id) ?? []));
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
      ...toApiProject(row, getTagsForProject(db, id)),
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
