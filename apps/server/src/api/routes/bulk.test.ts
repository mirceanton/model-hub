import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import type { BulkResponse } from "@model-hub/shared";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { files as filesTable, models as modelsTable, projects as projectsTable, type ModelRow } from "../../db/schema.js";
import { ensureMarkerId, TRASH_DIRNAME } from "../../lib/fs-utils.js";
import { getTagsForModel, getOrCreateTag } from "../../lib/tags.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { buildTestConfig } from "../../test-support/config.js";
import { registerModelRoutes } from "./models.js";
import { registerProjectRoutes } from "./projects.js";
import { registerTagRoutes } from "./tags.js";
import { registerVersionRoutes } from "./versions.js";

async function dirExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

function buildTestApp(db: DbClient, libraryRoot: string): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(multipart);
  const config = buildTestConfig();
  registerModelRoutes(app, db, libraryRoot, config);
  registerVersionRoutes(app, db, config);
  registerProjectRoutes(app, db);
  registerTagRoutes(app, db);
  return app;
}

/** Creates a fully reconciled (git-initialized, committed) model directory + DB row, the same way POST /api/models does. */
async function createTestModel(
  db: DbClient,
  libraryRoot: string,
  title: string,
  files: Record<string, string> = { "model.stl": "solid\nendsolid\n" },
): Promise<ModelRow> {
  const dirPath = join(libraryRoot, title);
  await mkdir(dirPath, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dirPath, name), content, "utf8");
  }

  const { id: fsId } = await ensureMarkerId(dirPath);
  const now = new Date();
  const inserted = db
    .insert(modelsTable)
    .values({ fsId, path: dirPath, title, createdAt: now, updatedAt: now })
    .returning()
    .get();

  await reconcileModelCore(db, inserted, {
    identity: LOCAL_UPLOAD_IDENTITY,
    commitMessage: "Initial import",
  });

  return db.select().from(modelsTable).where(eq(modelsTable.id, inserted.id)).get()!;
}

describe("bulk operations", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-bulk-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildTestApp(db, libraryRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  describe("POST /api/models/bulk", () => {
    it("trashes every requested model via the exact same trash-move path as the single DELETE route", async () => {
      const a = await createTestModel(db, libraryRoot, "Alpha");
      const b = await createTestModel(db, libraryRoot, "Beta");

      const res = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [a.id, b.id], action: "delete" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as BulkResponse;
      expect(body.results).toEqual(
        expect.arrayContaining([
          { id: a.id, success: true },
          { id: b.id, success: true },
        ]),
      );

      expect(await dirExists(a.path)).toBe(false);
      expect(await dirExists(b.path)).toBe(false);
      const rowA = db.select().from(modelsTable).where(eq(modelsTable.id, a.id)).get()!;
      const rowB = db.select().from(modelsTable).where(eq(modelsTable.id, b.id)).get()!;
      expect(rowA.deletedAt).not.toBeNull();
      expect(rowB.deletedAt).not.toBeNull();
      expect(rowA.path.startsWith(join(libraryRoot, TRASH_DIRNAME))).toBe(true);
    });

    it("reports a per-item failure for an id that's already gone, without failing the rest of the batch", async () => {
      const a = await createTestModel(db, libraryRoot, "Alpha");
      const missingId = 999_999;

      const res = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [a.id, missingId], action: "delete" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as BulkResponse;
      const byId = new Map(body.results.map((r) => [r.id, r]));
      expect(byId.get(a.id)).toEqual({ id: a.id, success: true });
      expect(byId.get(missingId)).toMatchObject({ id: missingId, success: false });

      expect(await dirExists(a.path)).toBe(false);
    });

    it("reports a failure (not a crash) for a model trashed by someone else moments earlier", async () => {
      const a = await createTestModel(db, libraryRoot, "Alpha");
      const b = await createTestModel(db, libraryRoot, "Beta");

      // Simulate model A already having been trashed by a concurrent request.
      const preTrashedPath = join(libraryRoot, TRASH_DIRNAME, `${a.fsId}-pre-trashed`);
      await mkdir(join(libraryRoot, TRASH_DIRNAME), { recursive: true });
      await rename(a.path, preTrashedPath);
      db.update(modelsTable)
        .set({ path: preTrashedPath, deletedAt: new Date() })
        .where(eq(modelsTable.id, a.id))
        .run();

      const res = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [a.id, b.id], action: "delete" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as BulkResponse;
      const byId = new Map(body.results.map((r) => [r.id, r]));
      expect(byId.get(a.id)?.success).toBe(false);
      expect(byId.get(b.id)).toEqual({ id: b.id, success: true });
      expect(await dirExists(b.path)).toBe(false);
    });

    it("bulk-favorites and bulk-unfavorites", async () => {
      const a = await createTestModel(db, libraryRoot, "Alpha");
      const b = await createTestModel(db, libraryRoot, "Beta");

      const favRes = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [a.id, b.id], action: "favorite" },
      });
      expect(favRes.statusCode).toBe(200);
      expect((favRes.json() as BulkResponse).results.every((r) => r.success)).toBe(true);
      expect(db.select().from(modelsTable).where(eq(modelsTable.id, a.id)).get()!.favorite).toBe(true);
      expect(db.select().from(modelsTable).where(eq(modelsTable.id, b.id)).get()!.favorite).toBe(true);

      const unfavRes = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [a.id], action: "unfavorite" },
      });
      expect(unfavRes.statusCode).toBe(200);
      expect(db.select().from(modelsTable).where(eq(modelsTable.id, a.id)).get()!.favorite).toBe(false);
      expect(db.select().from(modelsTable).where(eq(modelsTable.id, b.id)).get()!.favorite).toBe(true);
    });

    it("bulk add-tag attaches an existing-or-created tag to every requested model", async () => {
      const a = await createTestModel(db, libraryRoot, "Alpha");
      const b = await createTestModel(db, libraryRoot, "Beta");

      const res = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [a.id, b.id], action: "add-tag", tagName: "Benchy" },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as BulkResponse).results.every((r) => r.success)).toBe(true);

      expect(getTagsForModel(db, a.id).map((t) => t.name)).toEqual(["Benchy"]);
      expect(getTagsForModel(db, b.id).map((t) => t.name)).toEqual(["Benchy"]);
    });

    it("bulk remove-tag detaches a tag from every requested model and drops it once unused", async () => {
      const a = await createTestModel(db, libraryRoot, "Alpha");
      const b = await createTestModel(db, libraryRoot, "Beta");
      const tag = getOrCreateTag(db, "Benchy");
      for (const m of [a, b]) {
        await app.inject({
          method: "POST",
          url: `/api/models/${m.id}/tags`,
          payload: { name: "Benchy" },
        });
      }

      const res = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [a.id, b.id], action: "remove-tag", tagId: tag.id },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as BulkResponse).results.every((r) => r.success)).toBe(true);
      expect(getTagsForModel(db, a.id)).toEqual([]);
      expect(getTagsForModel(db, b.id)).toEqual([]);

      const tagsRes = await app.inject({ method: "GET", url: "/api/tags" });
      expect((tagsRes.json() as { id: number }[]).some((t) => t.id === tag.id)).toBe(false);
    });

    it("400s on an empty ids array, an unknown action, or a missing action-specific field", async () => {
      const a = await createTestModel(db, libraryRoot, "Alpha");

      const emptyIds = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [], action: "delete" },
      });
      expect(emptyIds.statusCode).toBe(400);

      const badAction = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [a.id], action: "nope" },
      });
      expect(badAction.statusCode).toBe(400);

      const noTagName = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [a.id], action: "add-tag" },
      });
      expect(noTagName.statusCode).toBe(400);

      const noTagId = await app.inject({
        method: "POST",
        url: "/api/models/bulk",
        payload: { ids: [a.id], action: "remove-tag" },
      });
      expect(noTagId.statusCode).toBe(400);
    });
  });

  describe("POST /api/models/:id/files/bulk", () => {
    it("deletes every requested file via the same per-file commit path as the single DELETE route", async () => {
      const model = await createTestModel(db, libraryRoot, "Multi", {
        "a.stl": "solid a\nendsolid a\n",
        "b.stl": "solid b\nendsolid b\n",
        "c.stl": "solid c\nendsolid c\n",
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/models/${model.id}/files/bulk`,
        payload: { ids: ["a.stl", "b.stl"], action: "delete" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as BulkResponse<string>;
      expect(body.results).toEqual(
        expect.arrayContaining([
          { id: "a.stl", success: true },
          { id: "b.stl", success: true },
        ]),
      );

      const remaining = db.select().from(filesTable).where(eq(filesTable.modelId, model.id)).all();
      expect(remaining.map((f) => f.relativePath).sort()).toEqual(["c.stl"]);
    });

    it("reports a per-item failure for a file that no longer exists, without failing the rest of the batch", async () => {
      const model = await createTestModel(db, libraryRoot, "Partial", {
        "a.stl": "solid a\nendsolid a\n",
        "b.stl": "solid b\nendsolid b\n",
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/models/${model.id}/files/bulk`,
        payload: { ids: ["a.stl", "missing.stl"], action: "delete" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as BulkResponse<string>;
      const byId = new Map(body.results.map((r) => [r.id, r]));
      expect(byId.get("a.stl")?.success).toBe(true);
      expect(byId.get("missing.stl")).toMatchObject({ success: false, error: "file not found" });

      const remaining = db.select().from(filesTable).where(eq(filesTable.modelId, model.id)).all();
      expect(remaining.map((f) => f.relativePath)).toEqual(["b.stl"]);
    });

    it("404s for a model that doesn't exist", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/models/999999/files/bulk",
        payload: { ids: ["a.stl"], action: "delete" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("400s on an empty ids array or an unknown action", async () => {
      const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "solid a\nendsolid a\n" });

      const emptyIds = await app.inject({
        method: "POST",
        url: `/api/models/${model.id}/files/bulk`,
        payload: { ids: [], action: "delete" },
      });
      expect(emptyIds.statusCode).toBe(400);

      const badAction = await app.inject({
        method: "POST",
        url: `/api/models/${model.id}/files/bulk`,
        payload: { ids: ["a.stl"], action: "nope" },
      });
      expect(badAction.statusCode).toBe(400);
    });
  });

  describe("POST /api/projects/:id/pins/bulk", () => {
    async function createProjectWithPins(modelTitles: string[]) {
      const models = await Promise.all(modelTitles.map((title) => createTestModel(db, libraryRoot, title)));
      const projectRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { title: "Bundle" },
      });
      const project = projectRes.json() as { id: number };
      for (const model of models) {
        const pinRes = await app.inject({
          method: "POST",
          url: `/api/projects/${project.id}/pins`,
          payload: { modelId: model.id },
        });
        expect(pinRes.statusCode).toBe(201);
      }
      return { project, models };
    }

    it("bulk-removes every requested pin", async () => {
      const { project, models } = await createProjectWithPins(["Alpha", "Beta"]);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/pins/bulk`,
        payload: { ids: models.map((m) => m.id), action: "remove" },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as BulkResponse).results.every((r) => r.success)).toBe(true);

      const detail = await app.inject({ method: "GET", url: `/api/projects/${project.id}` });
      expect((detail.json() as { pins: unknown[] }).pins).toEqual([]);
    });

    it("reports a per-item failure when removing a model id that isn't pinned to the project", async () => {
      const { project, models } = await createProjectWithPins(["Alpha"]);
      const notPinned = await createTestModel(db, libraryRoot, "Beta");

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/pins/bulk`,
        payload: { ids: [models[0]!.id, notPinned.id], action: "remove" },
      });
      expect(res.statusCode).toBe(200);
      const byId = new Map((res.json() as BulkResponse).results.map((r) => [r.id, r]));
      expect(byId.get(models[0]!.id)).toEqual({ id: models[0]!.id, success: true });
      expect(byId.get(notPinned.id)).toMatchObject({ success: false });
    });

    it("bulk-bumps every requested pin to its model's current commit, reusing resolvePinTarget", async () => {
      const { project, models } = await createProjectWithPins(["Alpha", "Beta"]);
      const [a, b] = models as [(typeof models)[number], (typeof models)[number]];
      const originalShaA = a.lastSyncedCommitSha!;

      // Advance model A to a new commit; the pin should still point at the old one until bumped.
      await writeFile(join(a.path, "model.stl"), "solid a-v2\nendsolid a-v2\n", "utf8");
      const updatedA = db.select().from(modelsTable).where(eq(modelsTable.id, a.id)).get()!;
      await reconcileModelCore(db, updatedA, { identity: LOCAL_UPLOAD_IDENTITY, commitMessage: "v2" });
      const refreshedA = db.select().from(modelsTable).where(eq(modelsTable.id, a.id)).get()!;
      expect(refreshedA.lastSyncedCommitSha).not.toBe(originalShaA);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/pins/bulk`,
        payload: { ids: [a.id, b.id], action: "bump" },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as BulkResponse).results.every((r) => r.success)).toBe(true);

      const detail = await app.inject({ method: "GET", url: `/api/projects/${project.id}` });
      const pins = (detail.json() as { pins: { modelId: number; pinnedCommitSha: string }[] }).pins;
      expect(pins.find((p) => p.modelId === a.id)?.pinnedCommitSha).toBe(refreshedA.lastSyncedCommitSha);
      expect(pins.find((p) => p.modelId === b.id)?.pinnedCommitSha).toBe(b.lastSyncedCommitSha);
    });

    it("reports a per-item failure when bumping a pin whose model has since been trashed", async () => {
      const { project, models } = await createProjectWithPins(["Alpha", "Beta"]);
      const [a, b] = models as [(typeof models)[number], (typeof models)[number]];

      const deleteRes = await app.inject({ method: "DELETE", url: `/api/models/${a.id}` });
      expect(deleteRes.statusCode).toBe(204);

      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/pins/bulk`,
        payload: { ids: [a.id, b.id], action: "bump" },
      });
      expect(res.statusCode).toBe(200);
      const byId = new Map((res.json() as BulkResponse).results.map((r) => [r.id, r]));
      expect(byId.get(a.id)).toMatchObject({ success: false, error: "model not found" });
      expect(byId.get(b.id)).toEqual({ id: b.id, success: true });
    });

    it("404s for a project that doesn't exist", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/999999/pins/bulk",
        payload: { ids: [1], action: "remove" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("400s on an empty ids array or an unknown action", async () => {
      const { project } = await createProjectWithPins(["Alpha"]);

      const emptyIds = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/pins/bulk`,
        payload: { ids: [], action: "remove" },
      });
      expect(emptyIds.statusCode).toBe(400);

      const badAction = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/pins/bulk`,
        payload: { ids: [1], action: "nope" },
      });
      expect(badAction.statusCode).toBe(400);
    });
  });

  describe("POST /api/projects/bulk", () => {
    async function createProject(title: string): Promise<{ id: number }> {
      const res = await app.inject({ method: "POST", url: "/api/projects", payload: { title } });
      return res.json() as { id: number };
    }

    it("deletes every requested project", async () => {
      const a = await createProject("Alpha");
      const b = await createProject("Beta");

      const res = await app.inject({
        method: "POST",
        url: "/api/projects/bulk",
        payload: { ids: [a.id, b.id], action: "delete" },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as BulkResponse).results.every((r) => r.success)).toBe(true);

      const rows = db.select().from(projectsTable).all();
      expect(rows).toEqual([]);
    });

    it("reports a per-item failure for a project id that doesn't exist, without failing the rest of the batch", async () => {
      const a = await createProject("Alpha");
      const missingId = 999_999;

      const res = await app.inject({
        method: "POST",
        url: "/api/projects/bulk",
        payload: { ids: [a.id, missingId], action: "delete" },
      });
      expect(res.statusCode).toBe(200);
      const byId = new Map((res.json() as BulkResponse).results.map((r) => [r.id, r]));
      expect(byId.get(a.id)).toEqual({ id: a.id, success: true });
      expect(byId.get(missingId)).toMatchObject({ success: false });

      const rows = db.select().from(projectsTable).all();
      expect(rows).toEqual([]);
    });

    it("400s on an empty ids array or an unknown action", async () => {
      const emptyIds = await app.inject({
        method: "POST",
        url: "/api/projects/bulk",
        payload: { ids: [], action: "delete" },
      });
      expect(emptyIds.statusCode).toBe(400);

      const badAction = await app.inject({
        method: "POST",
        url: "/api/projects/bulk",
        payload: { ids: [1], action: "nope" },
      });
      expect(badAction.statusCode).toBe(400);
    });
  });
});
