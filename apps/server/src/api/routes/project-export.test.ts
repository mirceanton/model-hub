import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { models as modelsTable, type ModelRow } from "../../db/schema.js";
import { ensureMarkerId } from "../../lib/fs-utils.js";
import { buildTestConfig } from "../../test-support/config.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { registerModelRoutes } from "./models.js";
import { registerProjectExportRoutes } from "./project-export.js";
import { registerProjectRoutes } from "./projects.js";

function buildTestApp(db: DbClient, libraryRoot: string): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(multipart);
  registerModelRoutes(app, db, libraryRoot, buildTestConfig());
  registerProjectRoutes(app, db);
  registerProjectExportRoutes(app, db);
  return app;
}

/** Creates a fully reconciled (git-initialized, committed) model directory + DB row. */
async function createTestModel(
  db: DbClient,
  libraryRoot: string,
  title: string,
  files: Record<string, string>,
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

/** Writes new content over an existing tracked file and commits it as a new version, returning the fresh row (with its updated lastSyncedCommitSha). */
async function updateTestModel(
  db: DbClient,
  model: ModelRow,
  files: Record<string, string>,
  commitMessage: string,
): Promise<ModelRow> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(model.path, name), content, "utf8");
  }
  await reconcileModelCore(db, model, { identity: LOCAL_UPLOAD_IDENTITY, commitMessage });
  return db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
}

describe("GET /api/projects/:id/export", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-project-export-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildTestApp(db, libraryRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("exports a model pinned to an older commit with that commit's files, not the model's current head", async () => {
    const model = await createTestModel(db, libraryRoot, "Widget", {
      "model.stl": "solid v1\nendsolid v1\n",
    });
    const v1Sha = model.lastSyncedCommitSha!;

    const updated = await updateTestModel(
      db,
      model,
      { "model.stl": "solid v2\nendsolid v2\n" },
      "Update to v2",
    );
    const v2Sha = updated.lastSyncedCommitSha!;
    expect(v2Sha).not.toBe(v1Sha);

    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "My Project" },
    });
    const project = projectRes.json() as { id: number };

    const pinRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/pins`,
      payload: { modelId: model.id, commitSha: v1Sha },
    });
    expect(pinRes.statusCode).toBe(201);
    const pin = pinRes.json() as { isOutdated: boolean };
    expect(pin.isOutdated).toBe(true); // model has since moved to v2Sha

    const exportRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}/export` });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.headers["content-type"]).toBe("application/zip");
    expect(exportRes.headers["content-disposition"]).toContain("My Project.zip");

    const zip = new AdmZip(exportRes.rawPayload);
    const entries = zip.getEntries();

    const modelFileEntry = entries.find((e) => e.entryName === "Widget/model.stl");
    expect(modelFileEntry).toBeDefined();
    expect(modelFileEntry!.getData().toString("utf8")).toBe("solid v1\nendsolid v1\n");

    const manifestEntry = entries.find((e) => e.entryName === "project.json");
    expect(manifestEntry).toBeDefined();
    const manifest = JSON.parse(manifestEntry!.getData().toString("utf8")) as {
      projectId: number;
      models: {
        modelId: number;
        modelTitle: string;
        directory: string;
        pinnedCommitSha: string;
        isOutdated: boolean;
        fileCount: number;
        exportError: string | null;
      }[];
    };
    expect(manifest.projectId).toBe(project.id);
    expect(manifest.models).toHaveLength(1);
    expect(manifest.models[0]).toMatchObject({
      modelId: model.id,
      modelTitle: "Widget",
      directory: "Widget",
      pinnedCommitSha: v1Sha,
      isOutdated: true,
      fileCount: 1,
      exportError: null,
    });
  });

  it("exports a pin to a currently-trashed model (its repo is still physically present under .trash/ until purge)", async () => {
    const model = await createTestModel(db, libraryRoot, "Trashed Widget", {
      "model.stl": "solid only\nendsolid only\n",
    });

    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Trash Project" },
    });
    const project = projectRes.json() as { id: number };

    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/pins`,
      payload: { modelId: model.id },
    });

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/models/${model.id}` });
    expect(deleteRes.statusCode).toBe(204);

    const trashedRow = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    expect(trashedRow.deletedAt).not.toBeNull();

    const exportRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}/export` });
    expect(exportRes.statusCode).toBe(200);

    const zip = new AdmZip(exportRes.rawPayload);
    const entries = zip.getEntries();
    const modelFileEntry = entries.find((e) => e.entryName === "Trashed Widget/model.stl");
    expect(modelFileEntry).toBeDefined();
    expect(modelFileEntry!.getData().toString("utf8")).toBe("solid only\nendsolid only\n");
  });

  it("disambiguates two pinned models that sanitize to the same directory name", async () => {
    const modelA = await createTestModel(db, libraryRoot, "Dup:Name", { "a.stl": "solid a\nendsolid a\n" });
    const modelB = await createTestModel(db, libraryRoot, "Dup*Name", { "b.stl": "solid b\nendsolid b\n" });

    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Collision Project" },
    });
    const project = projectRes.json() as { id: number };

    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/pins`,
      payload: { modelId: modelA.id },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/pins`,
      payload: { modelId: modelB.id },
    });

    const exportRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}/export` });
    const zip = new AdmZip(exportRes.rawPayload);
    const dirs = new Set(zip.getEntries().map((e) => e.entryName.split("/")[0]));
    expect(dirs.has("Dup Name")).toBe(true);
    expect(dirs.has("Dup Name (2)")).toBe(true);
  });

  it("404s for a project that doesn't exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/999999/export" });
    expect(res.statusCode).toBe(404);
  });
});
