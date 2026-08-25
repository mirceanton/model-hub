import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { files as filesTable, models as modelsTable, type ModelRow } from "../db/schema.js";
import { computeDuplicateModelMap, getDuplicateModels } from "./duplicates.js";

function insertModel(db: DbClient, title: string, deletedAt: Date | null = null): ModelRow {
  const now = new Date();
  return db
    .insert(modelsTable)
    .values({
      fsId: randomUUID(),
      path: `/library/${title}`,
      title,
      deletedAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

function insertFile(
  db: DbClient,
  modelId: number,
  relativePath: string,
  contentHash: string | null,
  extension = "stl",
): void {
  const now = new Date();
  db.insert(filesTable)
    .values({ modelId, relativePath, sizeBytes: 100, mtime: now, extension, contentHash })
    .run();
}

describe("computeDuplicateModelMap / getDuplicateModels", () => {
  let db: DbClient;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);
  });

  it("flags two active models that share a file with an identical content hash", () => {
    const modelA = insertModel(db, "Model A");
    const modelB = insertModel(db, "Model B");
    insertFile(db, modelA.id, "part.stl", "hash-shared");
    insertFile(db, modelB.id, "part.stl", "hash-shared");

    const map = computeDuplicateModelMap(db);

    expect(map.get(modelA.id)).toEqual([{ modelId: modelB.id, modelTitle: "Model B" }]);
    expect(map.get(modelB.id)).toEqual([{ modelId: modelA.id, modelTitle: "Model A" }]);
    expect(getDuplicateModels(db, modelA.id)).toEqual([{ modelId: modelB.id, modelTitle: "Model B" }]);
  });

  it("does not flag two models whose files have different content hashes", () => {
    const modelA = insertModel(db, "Model A");
    const modelB = insertModel(db, "Model B");
    insertFile(db, modelA.id, "part.stl", "hash-a");
    insertFile(db, modelB.id, "part.stl", "hash-b");

    const map = computeDuplicateModelMap(db);

    expect(map.get(modelA.id)).toBeUndefined();
    expect(map.get(modelB.id)).toBeUndefined();
    expect(getDuplicateModels(db, modelA.id)).toEqual([]);
  });

  it("ignores files that haven't been hashed yet (null contentHash)", () => {
    const modelA = insertModel(db, "Model A");
    const modelB = insertModel(db, "Model B");
    insertFile(db, modelA.id, "part.stl", null);
    insertFile(db, modelB.id, "part.stl", null);

    expect(getDuplicateModels(db, modelA.id)).toEqual([]);
  });

  it("excludes a trashed model from being reported as, or matched against, a duplicate", () => {
    const active = insertModel(db, "Active");
    const trashed = insertModel(db, "Trashed", new Date());
    insertFile(db, active.id, "part.stl", "hash-shared");
    insertFile(db, trashed.id, "part.stl", "hash-shared");

    expect(getDuplicateModels(db, active.id)).toEqual([]);
    expect(getDuplicateModels(db, trashed.id)).toEqual([]);
  });

  it("flags a model as a duplicate of multiple others that share the same hash", () => {
    const modelA = insertModel(db, "Model A");
    const modelB = insertModel(db, "Model B");
    const modelC = insertModel(db, "Model C");
    insertFile(db, modelA.id, "part.stl", "hash-shared");
    insertFile(db, modelB.id, "part.stl", "hash-shared");
    insertFile(db, modelC.id, "part.stl", "hash-shared");

    expect(getDuplicateModels(db, modelA.id).map((d) => d.modelId).sort()).toEqual(
      [modelB.id, modelC.id].sort(),
    );
  });

  it("does not flag a model as its own duplicate when it has multiple files with distinct hashes", () => {
    const model = insertModel(db, "Solo");
    insertFile(db, model.id, "a.stl", "hash-a");
    insertFile(db, model.id, "b.stl", "hash-b");

    expect(getDuplicateModels(db, model.id)).toEqual([]);
  });

  it("does not flag two models that only share an identical attachment, not a model file", () => {
    const modelA = insertModel(db, "Model A");
    const modelB = insertModel(db, "Model B");
    insertFile(db, modelA.id, "part.stl", "hash-a");
    insertFile(db, modelB.id, "part.stl", "hash-b");
    insertFile(db, modelA.id, "instructions.pdf", "hash-shared-attachment", "pdf");
    insertFile(db, modelB.id, "instructions.pdf", "hash-shared-attachment", "pdf");

    expect(getDuplicateModels(db, modelA.id)).toEqual([]);
    expect(getDuplicateModels(db, modelB.id)).toEqual([]);
  });
});
