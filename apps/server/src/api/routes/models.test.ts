import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { models as modelsTable, type ModelRow } from "../../db/schema.js";
import { ensureMarkerId } from "../../lib/fs-utils.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { registerModelRoutes } from "./models.js";

function buildTestApp(db: DbClient, libraryRoot: string): FastifyInstance {
  const app = Fastify({ logger: false });
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
    app = buildTestApp(db, libraryRoot);
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
