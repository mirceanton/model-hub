import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { models as modelsTable, type ModelRow } from "../../db/schema.js";
import { ensureMarkerId, TRASH_DIRNAME } from "../../lib/fs-utils.js";
import { getLog } from "../../sync/git.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { TRASH_RETENTION_MS, purgeExpiredTrash } from "../../sync/scanner.js";
import { registerModelRoutes } from "./models.js";
import { registerTrashRoutes } from "./trash.js";

async function dirExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

function buildTestApp(db: DbClient, libraryRoot: string): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(multipart);
  registerModelRoutes(app, db, libraryRoot);
  registerTrashRoutes(app, db, libraryRoot);
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

describe("trash routes", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-trash-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildTestApp(db, libraryRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("delete -> trash -> restore round-trip keeps files, git history, and tags intact", async () => {
    const model = await createTestModel(db, libraryRoot, "Benchy");

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/models/${model.id}` });
    expect(deleteRes.statusCode).toBe(204);

    // Moved out of the normal library path, into .trash/, and marked deletedAt.
    expect(await dirExists(model.path)).toBe(false);
    const trashedRow = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    expect(trashedRow.deletedAt).not.toBeNull();
    expect(trashedRow.path.startsWith(join(libraryRoot, TRASH_DIRNAME))).toBe(true);
    expect(await dirExists(trashedRow.path)).toBe(true);
    // The identity marker travels with the moved directory.
    expect(await dirExists(join(trashedRow.path, ".modelhub-id"))).toBe(true);

    // Excluded from the normal library list.
    const listRes = await app.inject({ method: "GET", url: "/api/models" });
    const listBody = listRes.json() as { data: { id: number }[] };
    expect(listBody.data.some((m) => m.id === model.id)).toBe(false);

    // Shows up in the trash listing.
    const trashListRes = await app.inject({ method: "GET", url: "/api/trash" });
    const trashListBody = trashListRes.json() as { id: number; title: string }[];
    expect(trashListBody.some((m) => m.id === model.id && m.title === "Benchy")).toBe(true);

    const restoreRes = await app.inject({
      method: "POST",
      url: `/api/trash/${model.id}/restore`,
    });
    expect(restoreRes.statusCode).toBe(200);
    const restoreBody = restoreRes.json() as { ok: true; path: string };
    expect(restoreBody.path).toBe(join(libraryRoot, "Benchy"));

    const restoredRow = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    expect(restoredRow.deletedAt).toBeNull();
    expect(restoredRow.path).toBe(join(libraryRoot, "Benchy"));
    expect(await dirExists(join(libraryRoot, "Benchy", "model.stl"))).toBe(true);

    const log = await getLog(restoredRow.path);
    expect(log.some((entry) => entry.message === "Initial import")).toBe(true);

    // Back in the normal library list.
    const listAfterRestore = await app.inject({ method: "GET", url: "/api/models" });
    const listAfterRestoreBody = listAfterRestore.json() as { data: { id: number }[] };
    expect(listAfterRestoreBody.data.some((m) => m.id === model.id)).toBe(true);

    // No longer in the trash listing.
    const trashAfterRestore = await app.inject({ method: "GET", url: "/api/trash" });
    const trashAfterRestoreBody = trashAfterRestore.json() as { id: number }[];
    expect(trashAfterRestoreBody.some((m) => m.id === model.id)).toBe(false);
  });

  it("restores to a disambiguated ' (2)' path when the original name has since been reused", async () => {
    const modelA = await createTestModel(db, libraryRoot, "Widget");
    const deleteRes = await app.inject({ method: "DELETE", url: `/api/models/${modelA.id}` });
    expect(deleteRes.statusCode).toBe(204);

    // A different model now occupies the original "Widget" directory name.
    const modelB = await createTestModel(db, libraryRoot, "Widget");
    expect(modelB.path).toBe(join(libraryRoot, "Widget"));

    const restoreRes = await app.inject({
      method: "POST",
      url: `/api/trash/${modelA.id}/restore`,
    });
    expect(restoreRes.statusCode).toBe(200);
    const restoreBody = restoreRes.json() as { ok: true; path: string };
    expect(restoreBody.path).toBe(join(libraryRoot, "Widget (2)"));

    // modelB's directory is untouched.
    expect(await dirExists(join(libraryRoot, "Widget", "model.stl"))).toBe(true);
    const modelBRow = db.select().from(modelsTable).where(eq(modelsTable.id, modelB.id)).get()!;
    expect(modelBRow.path).toBe(join(libraryRoot, "Widget"));

    const modelARow = db.select().from(modelsTable).where(eq(modelsTable.id, modelA.id)).get()!;
    expect(modelARow.path).toBe(join(libraryRoot, "Widget (2)"));
    expect(modelARow.deletedAt).toBeNull();
  });

  it("permanently deletes the directory and DB row via the purge route", async () => {
    const model = await createTestModel(db, libraryRoot, "Gadget");
    await app.inject({ method: "DELETE", url: `/api/models/${model.id}` });

    const trashedRow = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;

    const purgeRes = await app.inject({ method: "DELETE", url: `/api/trash/${model.id}` });
    expect(purgeRes.statusCode).toBe(204);

    expect(db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()).toBeUndefined();
    expect(await dirExists(trashedRow.path)).toBe(false);
  });

  it("404s restore/purge for a model id that isn't trashed", async () => {
    const model = await createTestModel(db, libraryRoot, "Untouched");

    const restoreRes = await app.inject({
      method: "POST",
      url: `/api/trash/${model.id}/restore`,
    });
    expect(restoreRes.statusCode).toBe(404);

    const purgeRes = await app.inject({ method: "DELETE", url: `/api/trash/${model.id}` });
    expect(purgeRes.statusCode).toBe(404);
  });

  it("auto-purges trash older than the retention window and leaves fresher trash alone", async () => {
    const oldModel = await createTestModel(db, libraryRoot, "Old");
    const freshModel = await createTestModel(db, libraryRoot, "Fresh");

    await app.inject({ method: "DELETE", url: `/api/models/${oldModel.id}` });
    await app.inject({ method: "DELETE", url: `/api/models/${freshModel.id}` });

    const oldTrashedPath = db
      .select()
      .from(modelsTable)
      .where(eq(modelsTable.id, oldModel.id))
      .get()!.path;

    // Backdate only the "old" one past the retention window.
    db.update(modelsTable)
      .set({ deletedAt: new Date(Date.now() - TRASH_RETENTION_MS - 1000) })
      .where(eq(modelsTable.id, oldModel.id))
      .run();

    const result = await purgeExpiredTrash(db);
    expect(result.purged).toBe(1);

    expect(db.select().from(modelsTable).where(eq(modelsTable.id, oldModel.id)).get()).toBeUndefined();
    expect(await dirExists(oldTrashedPath)).toBe(false);

    // The fresh one is untouched.
    const freshRow = db.select().from(modelsTable).where(eq(modelsTable.id, freshModel.id)).get();
    expect(freshRow?.deletedAt).not.toBeNull();
    expect(await dirExists(freshRow!.path)).toBe(true);
  });
});
