import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { files as filesTable, models as modelsTable, type ModelRow } from "../db/schema.js";
import { ensureMarkerId } from "../lib/fs-utils.js";
import * as hashModule from "../lib/hash.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "./reconcile.js";

async function createModelRow(db: DbClient, libraryRoot: string, title: string): Promise<ModelRow> {
  const dirPath = join(libraryRoot, title);
  await mkdir(dirPath, { recursive: true });
  const { id: fsId } = await ensureMarkerId(dirPath);
  const now = new Date();
  return db
    .insert(modelsTable)
    .values({ fsId, path: dirPath, title, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

describe("reconcileModelCore content hashing", () => {
  let libraryRoot: string;
  let db: DbClient;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-reconcile-hash-"));
    db = createDbClient(":memory:");
    runMigrations(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("populates files.contentHash with a SHA-256 hex digest during reconcile", async () => {
    const model = await createModelRow(db, libraryRoot, "Benchy");
    await writeFile(join(model.path, "model.stl"), "solid benchy\nendsolid benchy\n");

    await reconcileModelCore(db, model, {
      identity: LOCAL_UPLOAD_IDENTITY,
      commitMessage: "Initial import",
    });

    const fileRow = db.select().from(filesTable).where(eq(filesTable.modelId, model.id)).get()!;
    expect(fileRow.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two models with an identical file get the same content hash", async () => {
    const modelA = await createModelRow(db, libraryRoot, "Widget A");
    const modelB = await createModelRow(db, libraryRoot, "Widget B");
    const content = "solid widget\nendsolid widget\n";
    await writeFile(join(modelA.path, "widget.stl"), content);
    await writeFile(join(modelB.path, "widget.stl"), content);

    await reconcileModelCore(db, modelA, { identity: LOCAL_UPLOAD_IDENTITY, commitMessage: "Initial import" });
    await reconcileModelCore(db, modelB, { identity: LOCAL_UPLOAD_IDENTITY, commitMessage: "Initial import" });

    const rowA = db.select().from(filesTable).where(eq(filesTable.modelId, modelA.id)).get()!;
    const rowB = db.select().from(filesTable).where(eq(filesTable.modelId, modelB.id)).get()!;
    expect(rowA.contentHash).not.toBeNull();
    expect(rowA.contentHash).toBe(rowB.contentHash);
  });

  it("two models with different file contents get different hashes", async () => {
    const modelA = await createModelRow(db, libraryRoot, "Gadget A");
    const modelB = await createModelRow(db, libraryRoot, "Gadget B");
    await writeFile(join(modelA.path, "gadget.stl"), "solid gadget-a\nendsolid gadget-a\n");
    await writeFile(join(modelB.path, "gadget.stl"), "solid gadget-b\nendsolid gadget-b\n");

    await reconcileModelCore(db, modelA, { identity: LOCAL_UPLOAD_IDENTITY, commitMessage: "Initial import" });
    await reconcileModelCore(db, modelB, { identity: LOCAL_UPLOAD_IDENTITY, commitMessage: "Initial import" });

    const rowA = db.select().from(filesTable).where(eq(filesTable.modelId, modelA.id)).get()!;
    const rowB = db.select().from(filesTable).where(eq(filesTable.modelId, modelB.id)).get()!;
    expect(rowA.contentHash).not.toBe(rowB.contentHash);
  });

  it("does not rehash a file whose mtime/size are unchanged on a later reconcile", async () => {
    const model = await createModelRow(db, libraryRoot, "Stable");
    await writeFile(join(model.path, "model.stl"), "solid stable\nendsolid stable\n");

    await reconcileModelCore(db, model, { identity: LOCAL_UPLOAD_IDENTITY, commitMessage: "Initial import" });
    const firstRow = db.select().from(filesTable).where(eq(filesTable.modelId, model.id)).get()!;

    const hashSpy = vi.spyOn(hashModule, "sha256File");
    const freshModel = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    // Nothing changed on disk, so getStatus reports clean and no new commit
    // happens — reconcileModelCore should still refresh the files cache but
    // skip rehashing since mtime/size are unchanged.
    await reconcileModelCore(db, freshModel);

    expect(hashSpy).not.toHaveBeenCalled();
    const secondRow = db.select().from(filesTable).where(eq(filesTable.modelId, model.id)).get()!;
    expect(secondRow.contentHash).toBe(firstRow.contentHash);
  });

  it("rehashes a file after its contents (and mtime) change", async () => {
    const model = await createModelRow(db, libraryRoot, "Changing");
    const filePath = join(model.path, "model.stl");
    await writeFile(filePath, "solid v1\nendsolid v1\n");

    await reconcileModelCore(db, model, { identity: LOCAL_UPLOAD_IDENTITY, commitMessage: "Initial import" });
    const firstRow = db.select().from(filesTable).where(eq(filesTable.modelId, model.id)).get()!;

    await writeFile(filePath, "solid v2 - different content\nendsolid v2\n");
    // Force mtime forward in case the filesystem's timer resolution didn't
    // naturally advance it within this fast test run.
    const future = new Date(Date.now() + 5000);
    await utimes(filePath, future, future);

    const hashSpy = vi.spyOn(hashModule, "sha256File");
    const freshModel = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    await reconcileModelCore(db, freshModel, { identity: LOCAL_UPLOAD_IDENTITY });

    expect(hashSpy).toHaveBeenCalledTimes(1);
    const secondRow = db.select().from(filesTable).where(eq(filesTable.modelId, model.id)).get()!;
    expect(secondRow.contentHash).not.toBe(firstRow.contentHash);
  });
});
