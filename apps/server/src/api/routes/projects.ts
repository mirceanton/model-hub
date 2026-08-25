import type {
  BulkResponse,
  BulkResult,
  PinnedModel,
  Project,
  ProjectDetail,
  ProjectPinsBulkRequest,
  ProjectsBulkRequest,
} from "@model-hub/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../../auth/guard.js";
import type { DbClient } from "../../db/client.js";
import { projects as projectsTable, type ProjectRow } from "../../db/schema.js";
import { getActiveModel } from "../../lib/model-lookup.js";
import { dismissNotice, getActiveNoticesForProject } from "../../lib/project-notices.js";
import {
  addPin,
  getPinsForProject,
  getPinsForProjects,
  InvalidCommitShaError,
  ModelAlreadyPinnedError,
  ModelHasNoCommitsError,
  pinExists,
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
    hasCustomThumbnail: row.thumbnailImage != null,
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
    const notices = getActiveNoticesForProject(db, id);
    const detail: ProjectDetail = { ...toApiProject(row, pins), pins, notices };
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

  // See packages/shared/src/types.ts's BulkResponse doc comment for the
  // shape shared across every bulk endpoint in this app. Projects have no
  // filesystem/git of their own (see the single-item DELETE above), so
  // there's no lock or "missing directory" case to worry about here — a
  // missing project id is the only per-item failure mode.
  //
  // Gated behind requireRole("editor") — see models.ts's POST
  // /api/models/bulk for the general reasoning. Doubly warranted here
  // specifically: unlike a bulk model delete (which moves to trash and is
  // recoverable), a project delete is an unconditional hard delete with no
  // trash to fall back on — see the single-item DELETE above.
  app.post<{ Body: ProjectsBulkRequest }>(
    "/api/projects/bulk",
    { preHandler: requireRole("editor") },
    async (request, reply) => {
      const { ids, action } = request.body ?? ({} as ProjectsBulkRequest);
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
        return reply.code(400).send({ error: "ids must be a non-empty array of project ids" });
      }
      if (action !== "delete") {
        return reply.code(400).send({ error: 'action must be "delete"' });
      }

      const results: BulkResult[] = [];
      for (const id of ids) {
        const row = db
          .select({ id: projectsTable.id })
          .from(projectsTable)
          .where(eq(projectsTable.id, id))
          .get();
        if (!row) {
          results.push({ id, success: false, error: "project not found" });
          continue;
        }
        db.delete(projectsTable).where(eq(projectsTable.id, id)).run();
        results.push({ id, success: true });
      }

      const response: BulkResponse = { results };
      return response;
    },
  );

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

  // See packages/shared/src/types.ts's BulkResponse doc comment for the
  // shape shared across every bulk endpoint in this app. `ids` are modelIds
  // already pinned to this project. "bump" reuses resolvePinTarget exactly
  // like the single-item PATCH's "bump to latest" quick action does
  // (commitSha omitted -> re-pin to the model's current
  // lastSyncedCommitSha) — no separate sha-resolution logic. "remove" reuses
  // removePin, same as the single-item DELETE route, but first checks
  // pinExists so an id that was never (or no longer) pinned here shows up
  // as a per-item failure instead of a silent no-op success.
  //
  // Deliberately left ungated (unlike POST /api/models/bulk and POST
  // /api/projects/bulk above): both actions here are reversible and not
  // data-destructive — "remove" only drops a pin (the target model is
  // untouched and can be re-added), "bump" only repoints one — so neither
  // carries the "one click destroys dozens of things" risk that motivated
  // gating the other two bulk routes.
  app.post<{ Params: { id: string }; Body: ProjectPinsBulkRequest }>(
    "/api/projects/:id/pins/bulk",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) {
        return reply.code(400).send({ error: "invalid project id" });
      }
      const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
      if (!project) {
        return reply.code(404).send({ error: "project not found" });
      }

      const { ids, action } = request.body ?? ({} as ProjectPinsBulkRequest);
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((modelId) => !Number.isInteger(modelId))) {
        return reply.code(400).send({ error: "ids must be a non-empty array of model ids" });
      }
      if (action !== "remove" && action !== "bump") {
        return reply.code(400).send({ error: 'action must be "remove" or "bump"' });
      }

      const results: BulkResult[] = [];
      let anyChanged = false;
      for (const modelId of ids) {
        if (action === "remove") {
          if (!pinExists(db, id, modelId)) {
            results.push({ id: modelId, success: false, error: "model is not pinned to this project" });
            continue;
          }
          removePin(db, id, modelId);
          anyChanged = true;
          results.push({ id: modelId, success: true });
          continue;
        }

        // "bump": same exclusion as the single-item routes above — a
        // model that's since been trashed can't be re-pinned.
        const model = getActiveModel(db, modelId);
        if (!model) {
          results.push({ id: modelId, success: false, error: "model not found" });
          continue;
        }
        try {
          const { sha, message } = await resolvePinTarget(model, undefined);
          const pinRow = updatePin(db, id, modelId, sha, message);
          if (!pinRow) {
            results.push({ id: modelId, success: false, error: "model is not pinned to this project" });
            continue;
          }
          anyChanged = true;
          results.push({ id: modelId, success: true });
        } catch (err) {
          if (err instanceof InvalidCommitShaError || err instanceof ModelHasNoCommitsError) {
            results.push({ id: modelId, success: false, error: err.message });
          } else {
            throw err;
          }
        }
      }

      if (anyChanged) {
        db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, id)).run();
      }

      const response: BulkResponse = { results };
      return response;
    },
  );

  app.post<{ Params: { id: string; noticeId: string } }>(
    "/api/projects/:id/notices/:noticeId/dismiss",
    async (request, reply) => {
      const id = Number(request.params.id);
      const noticeId = Number(request.params.noticeId);
      if (!Number.isInteger(id) || !Number.isInteger(noticeId)) {
        return reply.code(400).send({ error: "invalid id" });
      }

      const dismissed = dismissNotice(db, id, noticeId);
      if (!dismissed) {
        return reply.code(404).send({ error: "notice not found" });
      }
      return reply.code(204).send();
    },
  );
}
