import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import type { UserRole } from "@model-hub/shared";
import AdmZip from "adm-zip";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAuthGuard } from "../../auth/guard.js";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { modelTags as modelTagsTable, models as modelsTable, type ModelRow } from "../../db/schema.js";
import { ensureMarkerId } from "../../lib/fs-utils.js";
import { getOrCreateTag } from "../../lib/tags.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { buildTestConfig } from "../../test-support/config.js";
import { registerModelExportRoutes } from "./model-export.js";
import { registerModelRoutes } from "./models.js";

interface ManifestModel {
  modelId: number;
  title: string;
  description: string;
  tags: string[];
  favorite: boolean;
  lastSyncedCommitSha: string | null;
  fileCount: number;
  directory: string;
  exportError: string | null;
}

/**
 * Builds the test app with the real auth guard wired in (single-user mode:
 * every request resolves to the synthetic admin local owner — see
 * auth/session.ts's ensureLocalOwner) so requireRole("admin") on the
 * full-library export route sees a real request.user instead of 401ing
 * outright. `roleOverride`, when given, swaps in a different role so the
 * admin-gating test can exercise the boundary — same pattern as bulk.test.ts.
 */
function buildTestApp(db: DbClient, libraryRoot: string, roleOverride?: UserRole): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(multipart);
  const config = buildTestConfig();
  registerAuthGuard(app, db, config);
  if (roleOverride) {
    app.addHook("onRequest", async (request) => {
      if (request.user) request.user = { ...request.user, role: roleOverride };
    });
  }
  registerModelRoutes(app, db, libraryRoot, config);
  registerModelExportRoutes(app, db);
  return app;
}

/** Creates a fully reconciled (git-initialized, committed) model directory + DB row. */
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

describe("model export", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-model-export-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildTestApp(db, libraryRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  describe("GET /api/models/:id/export", () => {
    it("zips a model's current files with a metadata.json sidecar", async () => {
      const model = await createTestModel(db, libraryRoot, "Widget", {
        "model.stl": "solid widget\nendsolid widget\n",
      });
      const tag = getOrCreateTag(db, "prop");
      db.insert(modelTagsTable).values({ modelId: model.id, tagId: tag.id }).run();
      db.update(modelsTable).set({ favorite: true, description: "a widget" }).where(eq(modelsTable.id, model.id)).run();

      const res = await app.inject({ method: "GET", url: `/api/models/${model.id}/export` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/zip");
      expect(res.headers["content-disposition"]).toContain("Widget.zip");

      const zip = new AdmZip(res.rawPayload);
      const entries = zip.getEntries();

      const fileEntry = entries.find((e) => e.entryName === "model.stl");
      expect(fileEntry).toBeDefined();
      expect(fileEntry!.getData().toString("utf8")).toBe("solid widget\nendsolid widget\n");

      const metadataEntry = entries.find((e) => e.entryName === "metadata.json");
      expect(metadataEntry).toBeDefined();
      const metadata = JSON.parse(metadataEntry!.getData().toString("utf8"));
      expect(metadata).toMatchObject({
        modelId: model.id,
        title: "Widget",
        description: "a widget",
        tags: ["prop"],
        favorite: true,
        fileCount: 1,
      });
      expect(metadata.lastSyncedCommitSha).toBe(model.lastSyncedCommitSha);
    });

    it("exports a currently-trashed model by explicit id (its repo is still physically present until purge)", async () => {
      const model = await createTestModel(db, libraryRoot, "Trashed Widget");
      const deleteRes = await app.inject({ method: "DELETE", url: `/api/models/${model.id}` });
      expect(deleteRes.statusCode).toBe(204);

      const trashedRow = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
      expect(trashedRow.deletedAt).not.toBeNull();

      const res = await app.inject({ method: "GET", url: `/api/models/${model.id}/export` });
      expect(res.statusCode).toBe(200);
      const zip = new AdmZip(res.rawPayload);
      expect(zip.getEntries().find((e) => e.entryName === "model.stl")).toBeDefined();
    });

    it("404s for a model id that was never created", async () => {
      const res = await app.inject({ method: "GET", url: "/api/models/999999/export" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/models/export", () => {
    it("bundles selected models into one zip, one subdirectory each, plus a root manifest.json", async () => {
      const modelA = await createTestModel(db, libraryRoot, "Alpha", { "a.stl": "solid a\nendsolid a\n" });
      const modelB = await createTestModel(db, libraryRoot, "Beta", { "b.stl": "solid b\nendsolid b\n" });

      const res = await app.inject({
        method: "POST",
        url: "/api/models/export",
        payload: { ids: [modelA.id, modelB.id] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/zip");

      const zip = new AdmZip(res.rawPayload);
      const entries = zip.getEntries();
      expect(entries.find((e) => e.entryName === "Alpha/a.stl")).toBeDefined();
      expect(entries.find((e) => e.entryName === "Beta/b.stl")).toBeDefined();

      const manifestEntry = entries.find((e) => e.entryName === "manifest.json");
      expect(manifestEntry).toBeDefined();
      const manifest = JSON.parse(manifestEntry!.getData().toString("utf8")) as { models: ManifestModel[] };
      expect(manifest.models).toHaveLength(2);
      expect(manifest.models.map((m) => m.title).sort()).toEqual(["Alpha", "Beta"]);
      for (const entry of manifest.models) {
        expect(entry.exportError).toBeNull();
        expect(entry.fileCount).toBe(1);
      }
    });

    it("disambiguates two selected models that sanitize to the same directory name", async () => {
      const modelA = await createTestModel(db, libraryRoot, "Dup:Name", { "a.stl": "solid a\nendsolid a\n" });
      const modelB = await createTestModel(db, libraryRoot, "Dup*Name", { "b.stl": "solid b\nendsolid b\n" });

      const res = await app.inject({
        method: "POST",
        url: "/api/models/export",
        payload: { ids: [modelA.id, modelB.id] },
      });
      const zip = new AdmZip(res.rawPayload);
      const dirs = new Set(zip.getEntries().map((e) => e.entryName.split("/")[0]));
      expect(dirs.has("Dup Name")).toBe(true);
      expect(dirs.has("Dup Name (2)")).toBe(true);
    });

    it("records a per-item exportError for an id that doesn't resolve, without failing the rest of the batch", async () => {
      const model = await createTestModel(db, libraryRoot, "Solo");

      const res = await app.inject({
        method: "POST",
        url: "/api/models/export",
        payload: { ids: [model.id, 999999] },
      });
      expect(res.statusCode).toBe(200);

      const zip = new AdmZip(res.rawPayload);
      const manifestEntry = zip.getEntries().find((e) => e.entryName === "manifest.json")!;
      const manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as { models: ManifestModel[] };
      const goodEntry = manifest.models.find((m) => m.modelId === model.id)!;
      expect(goodEntry.exportError).toBeNull();
      const missingEntry = manifest.models.find((m) => m.modelId === 999999)!;
      expect(missingEntry.exportError).toBe("model not found");
    });

    it("includes a trashed model when its id is explicitly selected", async () => {
      const model = await createTestModel(db, libraryRoot, "Trashed Selected");
      await app.inject({ method: "DELETE", url: `/api/models/${model.id}` });

      const res = await app.inject({
        method: "POST",
        url: "/api/models/export",
        payload: { ids: [model.id] },
      });
      expect(res.statusCode).toBe(200);
      const zip = new AdmZip(res.rawPayload);
      expect(zip.getEntries().find((e) => e.entryName === "Trashed Selected/model.stl")).toBeDefined();
    });

    it("400s when ids is missing, empty, or not an array of integers", async () => {
      for (const payload of [{}, { ids: [] }, { ids: ["not-a-number"] }]) {
        const res = await app.inject({ method: "POST", url: "/api/models/export", payload });
        expect(res.statusCode).toBe(400);
      }
    });

    it("404s when none of the requested ids resolve to a model", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/models/export",
        payload: { ids: [999999] },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/models/export (full library, admin-only)", () => {
    it("bundles every active model, excluding trashed ones", async () => {
      const modelA = await createTestModel(db, libraryRoot, "Kept A", { "a.stl": "solid a\nendsolid a\n" });
      const modelB = await createTestModel(db, libraryRoot, "Kept B", { "b.stl": "solid b\nendsolid b\n" });
      const trashed = await createTestModel(db, libraryRoot, "Purged Soon", { "c.stl": "solid c\nendsolid c\n" });
      await app.inject({ method: "DELETE", url: `/api/models/${trashed.id}` });

      const res = await app.inject({ method: "GET", url: "/api/models/export" });
      expect(res.statusCode).toBe(200);

      const zip = new AdmZip(res.rawPayload);
      const entries = zip.getEntries();
      expect(entries.find((e) => e.entryName === "Kept A/a.stl")).toBeDefined();
      expect(entries.find((e) => e.entryName === "Kept B/b.stl")).toBeDefined();
      expect(entries.find((e) => e.entryName.startsWith("Purged Soon"))).toBeUndefined();

      const manifestEntry = entries.find((e) => e.entryName === "manifest.json")!;
      const manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as { models: ManifestModel[] };
      expect(manifest.models.map((m) => m.modelId).sort()).toEqual([modelA.id, modelB.id].sort());
    });

    it("403s for a non-admin role", async () => {
      const nonAdminApp = buildTestApp(db, libraryRoot, "editor");
      await createTestModel(db, libraryRoot, "Widget");
      const res = await nonAdminApp.inject({ method: "GET", url: "/api/models/export" });
      expect(res.statusCode).toBe(403);
      await nonAdminApp.close();
    });

    it("succeeds for an admin role", async () => {
      const adminApp = buildTestApp(db, libraryRoot, "admin");
      await createTestModel(db, libraryRoot, "Widget");
      const res = await adminApp.inject({ method: "GET", url: "/api/models/export" });
      expect(res.statusCode).toBe(200);
      await adminApp.close();
    });
  });
});
