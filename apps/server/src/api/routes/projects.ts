import type { PinnedModel, Project, ProjectDetail } from "@model-hub/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { projects as projectsTable, type ProjectRow } from "../../db/schema.js";
import { getActiveModel } from "../../lib/model-lookup.js";
import {
  addPin,
  getPinsForProject,
  getPinsForProjects,
  InvalidCommitShaError,
  ModelAlreadyPinnedError,
  ModelHasNoCommitsError,
  removePin,
  resolvePinTarget,
  toPinnedModel,
  updatePin,
} from "../../lib/project-pins.js";

const PREVIEW_PIN_COUNT = 4;

function toApiProject(row: ProjectRow, pins: PinnedModel[]): Project {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    pinCount: pins.length,
    previewPins: pins.slice(0, PREVIEW_PIN_COUNT).map((p) => ({
      modelId: p.modelId,
      thumbnailPath: p.thumbnailPath,
      thumbnailStatus: p.thumbnailStatus,
    })),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function registerProjectRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Querystring: { q?: string } }>("/api/projects", async (request) => {
    let rows = db.select().from(projectsTable).all();

    const needle = request.query.q?.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((row) => row.title.toLowerCase().includes(needle));
    }

    const pinsByProject = getPinsForProjects(
      db,
      rows.map((row) => row.id),
    );
    return rows.map((row) => toApiProject(row, pinsByProject.get(row.id) ?? []));
  });

  app.post<{ Body: { title?: string; description?: string } }>(
    "/api/projects",
    async (request, reply) => {
      const title = request.body?.title?.trim();
      if (!title) {
        return reply.code(400).send({ error: "title is required" });
      }

      const now = new Date();
      const row = db
        .insert(projectsTable)
        .values({ title, description: request.body?.description ?? "", createdAt: now, updatedAt: now })
        .returning()
        .get();

      return reply.code(201).send(toApiProject(row, []));
    },
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid project id" });
    }

    const row = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
    if (!row) {
      return reply.code(404).send({ error: "project not found" });
    }

    const pins = getPinsForProject(db, id);
    const detail: ProjectDetail = { ...toApiProject(row, pins), pins };
    return detail;
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; description?: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid project id" });
      }

      const row = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
      if (!row) {
        return reply.code(404).send({ error: "project not found" });
      }

      const { title, description } = request.body ?? {};
      if (title !== undefined && title.trim().length === 0) {
        return reply.code(400).send({ error: "title cannot be empty" });
      }

      const updated = db
        .update(projectsTable)
        .set({
          ...(title !== undefined ? { title: title.trim() } : {}),
          ...(description !== undefined ? { description } : {}),
          updatedAt: new Date(),
        })
        .where(eq(projectsTable.id, id))
        .returning()
        .get();

      return toApiProject(updated, getPinsForProject(db, id));
    },
  );

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid project id" });
    }

    const row = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
    if (!row) {
      return reply.code(404).send({ error: "project not found" });
    }

    // Unlike models, a Project is a pure DB entity with no filesystem/git of
    // its own — always safe to delete outright, no "missing directory" gate.
    db.delete(projectsTable).where(eq(projectsTable.id, id)).run();
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { modelId?: number; commitSha?: string } }>(
    "/api/projects/:id/pins",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid project id" });
      }
      const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const modelId = request.body?.modelId;
      if (typeof modelId !== "number" || !Number.isInteger(modelId)) {
        return reply.code(400).send({ error: "modelId is required" });
      }

      // Excludes trashed models: a model's repo is still physically present
      // under .trash/ until purge, but it must not be selectable as a new
      // pin target — see CLAUDE.md's Projects section and the trash feature
      // notes in schema.ts.
      const model = getActiveModel(db, modelId);
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }

      try {
        const { sha, message } = await resolvePinTarget(model, request.body?.commitSha);
        const pinRow = addPin(db, id, model.id, sha, message);
        db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, id)).run();
        return reply.code(201).send(toPinnedModel(pinRow, model));
      } catch (err) {
        if (err instanceof InvalidCommitShaError || err instanceof ModelHasNoCommitsError) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof ModelAlreadyPinnedError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string; modelId: string }; Body: { commitSha?: string } }>(
    "/api/projects/:id/pins/:modelId",
    async (request, reply) => {
      const id = Number(request.params.id);
      const modelId = Number(request.params.modelId);
      if (!Number.isInteger(id) || !Number.isInteger(modelId)) {
        return reply.code(400).send({ error: "invalid id" });
      }

      const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }
      // Same exclusion as the create-pin route above: re-pinning (including
      // the "bump to latest" quick action) is a normal-route operation and
      // must not act on a model that's since been trashed.
      const model = getActiveModel(db, modelId);
      if (!model) {
        return reply.code(404).send({ error: "model not found" });
      }

      try {
        // commitSha is optional here too — omitting it re-pins to the
        // model's current commit, the "bump to latest" quick action.
        const { sha, message } = await resolvePinTarget(model, request.body?.commitSha);
        const pinRow = updatePin(db, id, modelId, sha, message);
        if (!pinRow) {
          return reply.code(404).send({ error: "model is not pinned to this project" });
        }
        db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, id)).run();
        return toPinnedModel(pinRow, model);
      } catch (err) {
        if (err instanceof InvalidCommitShaError || err instanceof ModelHasNoCommitsError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; modelId: string } }>(
    "/api/projects/:id/pins/:modelId",
    async (request, reply) => {
      const id = Number(request.params.id);
      const modelId = Number(request.params.modelId);
      if (!Number.isInteger(id) || !Number.isInteger(modelId)) {
        return reply.code(400).send({ error: "invalid id" });
      }

      removePin(db, id, modelId);
      db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, id)).run();
      return reply.code(204).send();
    },
  );
}
