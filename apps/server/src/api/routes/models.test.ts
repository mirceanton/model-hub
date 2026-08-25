import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { models as modelsTable, type ModelRow } from "../../db/schema.js";
import { ensureMarkerId } from "../../lib/fs-utils.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { registerModelRoutes } from "./models.js";

async function buildTestApp(db: DbClient, libraryRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(multipart);
  registerModelRoutes(app, db, libraryRoot);
  return app;
}

/** Creates a fully reconciled (git-initialized, committed, hashed) model directory + DB row. */
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

describe("duplicate detection surfaced on model routes", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-duplicates-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = await buildTestApp(db, libraryRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("flags two models with an identical file as duplicates of each other, in both the list and detail views", async () => {
    const sharedContent = "solid shared\nendsolid shared\n";
    const modelA = await createTestModel(db, libraryRoot, "Original", { "part.stl": sharedContent });
    const modelB = await createTestModel(db, libraryRoot, "Reupload", { "part.stl": sharedContent });

    const listRes = await app.inject({ method: "GET", url: "/api/models" });
    const listBody = listRes.json() as { data: { id: number; duplicateModels: { modelId: number }[] }[] };
    const listA = listBody.data.find((m) => m.id === modelA.id)!;
    const listB = listBody.data.find((m) => m.id === modelB.id)!;
    expect(listA.duplicateModels).toEqual([{ modelId: modelB.id, modelTitle: "Reupload" }]);
    expect(listB.duplicateModels).toEqual([{ modelId: modelA.id, modelTitle: "Original" }]);

    const detailRes = await app.inject({ method: "GET", url: `/api/models/${modelA.id}` });
    const detailBody = detailRes.json() as { duplicateModels: { modelId: number; modelTitle: string }[] };
    expect(detailBody.duplicateModels).toEqual([{ modelId: modelB.id, modelTitle: "Reupload" }]);
  });

  it("does not flag two models whose files differ", async () => {
    const modelA = await createTestModel(db, libraryRoot, "Alpha", { "a.stl": "solid a\nendsolid a\n" });
    const modelB = await createTestModel(db, libraryRoot, "Beta", { "b.stl": "solid b\nendsolid b\n" });

    const listRes = await app.inject({ method: "GET", url: "/api/models" });
    const listBody = listRes.json() as { data: { id: number; duplicateModels: unknown[] }[] };
    expect(listBody.data.find((m) => m.id === modelA.id)!.duplicateModels).toEqual([]);
    expect(listBody.data.find((m) => m.id === modelB.id)!.duplicateModels).toEqual([]);
  });
});

describe("attachments on the model detail route", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-attachments-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = await buildTestApp(db, libraryRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("splits images/pdf into `attachments`, keeping `files` model-only", async () => {
    const model = await createTestModel(db, libraryRoot, "Benchy", {
      "model.stl": "solid benchy\nendsolid benchy\n",
      "photo.jpg": "jpeg-bytes",
      "manual.pdf": "pdf-bytes",
    });

    const res = await app.inject({ method: "GET", url: `/api/models/${model.id}` });
    const body = res.json() as {
      files: { relativePath: string }[];
      attachments: { relativePath: string }[];
    };

    expect(body.files.map((f) => f.relativePath)).toEqual(["model.stl"]);
    expect(body.attachments.map((f) => f.relativePath).sort()).toEqual(["manual.pdf", "photo.jpg"]);
  });

  it("never picks an attachment as primaryFilePath, even when it's the only file", async () => {
    const model = await createTestModel(db, libraryRoot, "PhotosOnly", {
      "photo.jpg": "jpeg-bytes",
    });
    expect(model.primaryFilePath).toBeNull();
  });

  it("rejects PATCHing primaryFilePath to an attachment", async () => {
    const model = await createTestModel(db, libraryRoot, "Widget", {
      "model.stl": "solid widget\nendsolid widget\n",
      "photo.jpg": "jpeg-bytes",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/models/${model.id}`,
      payload: { primaryFilePath: "photo.jpg" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("model file") });
  });
});

describe("sourceUrl on the model routes", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-source-url-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = await buildTestApp(db, libraryRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("defaults to no sourceUrl and a 'none' snapshot status", async () => {
    const model = await createTestModel(db, libraryRoot, "Benchy", {
      "model.stl": "solid benchy\nendsolid benchy\n",
    });

    const res = await app.inject({ method: "GET", url: `/api/models/${model.id}` });
    const body = res.json() as {
      sourceUrl: string | null;
      sourceSnapshotStatus: string;
      sourceSnapshotHtml: string | null;
    };
    expect(body.sourceUrl).toBeNull();
    expect(body.sourceSnapshotStatus).toBe("none");
    expect(body.sourceSnapshotHtml).toBeNull();
  });

  it("PATCHing a valid http(s) sourceUrl sets it and marks the snapshot pending", async () => {
    const model = await createTestModel(db, libraryRoot, "Benchy", {
      "model.stl": "solid benchy\nendsolid benchy\n",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/models/${model.id}`,
      payload: { sourceUrl: "https://www.printables.com/model/12345-benchy" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { sourceUrl: string; sourceSnapshotStatus: string };
    expect(body.sourceUrl).toBe("https://www.printables.com/model/12345-benchy");
    expect(body.sourceSnapshotStatus).toBe("pending");
  });

  it("rejects a malformed sourceUrl", async () => {
    const model = await createTestModel(db, libraryRoot, "Benchy", {
      "model.stl": "solid benchy\nendsolid benchy\n",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/models/${model.id}`,
      payload: { sourceUrl: "not a url" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("http(s)") });
  });

  it("rejects a non-http(s) sourceUrl (e.g. file:// or javascript:)", async () => {
    const model = await createTestModel(db, libraryRoot, "Benchy", {
      "model.stl": "solid benchy\nendsolid benchy\n",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/models/${model.id}`,
      payload: { sourceUrl: "javascript:alert(1)" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("clearing sourceUrl also clears the stored snapshot", async () => {
    const model = await createTestModel(db, libraryRoot, "Benchy", {
      "model.stl": "solid benchy\nendsolid benchy\n",
    });
    await app.inject({
      method: "PATCH",
      url: `/api/models/${model.id}`,
      payload: { sourceUrl: "https://www.printables.com/model/12345-benchy" },
    });
    // Simulate a snapshot having completed, so we can prove clearing wipes it.
    db.update(modelsTable)
      .set({ sourceSnapshotStatus: "ready", sourceSnapshotHtml: "<p>cached</p>" })
      .where(eq(modelsTable.id, model.id))
      .run();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/models/${model.id}`,
      payload: { sourceUrl: null },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { sourceUrl: string | null; sourceSnapshotStatus: string };
    expect(body.sourceUrl).toBeNull();
    expect(body.sourceSnapshotStatus).toBe("none");

    const detailRes = await app.inject({ method: "GET", url: `/api/models/${model.id}` });
    expect((detailRes.json() as { sourceSnapshotHtml: string | null }).sourceSnapshotHtml).toBeNull();
  });

  it("accepts sourceUrl on model creation", async () => {
    const form = new FormData();
    form.append("title", "New Model");
    form.append("sourceUrl", "https://www.thingiverse.com/thing/12345");
    form.append("files", new Blob(["solid a\nendsolid a\n"]), "a.stl");

    const res = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: form,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as { sourceUrl: string; sourceSnapshotStatus: string };
    expect(body.sourceUrl).toBe("https://www.thingiverse.com/thing/12345");
    expect(body.sourceSnapshotStatus).toBe("pending");
  });

  it("rejects model creation with a malformed sourceUrl", async () => {
    const form = new FormData();
    form.append("title", "New Model");
    form.append("sourceUrl", "not a url");
    form.append("files", new Blob(["solid a\nendsolid a\n"]), "a.stl");

    const res = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: form,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("sourceUrl") });
  });
});
