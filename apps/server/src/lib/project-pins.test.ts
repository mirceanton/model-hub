import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  projectModelPins as projectModelPinsTable,
  projects as projectsTable,
  models as modelsTable,
  type ModelRow,
  type ProjectModelPinRow,
} from "../db/schema.js";
import { setPinPrinted, toPinnedModel } from "./project-pins.js";

const baseModel: ModelRow = {
  id: 1,
  fsId: "fs-id",
  path: "/library/some-model",
  title: "Some Model",
  description: "",
  primaryFilePath: "model.stl",
  thumbnailPath: null,
  thumbnailStatus: "ready",
  thumbnailSource: "auto",
  lastSyncedCommitSha: "a".repeat(40),
  lastSyncedAt: new Date(),
  syncStatus: "ok",
  syncError: null,
  missingSince: null,
  favorite: false,
  sourceUrl: null,
  deletedAt: null,
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const basePin: ProjectModelPinRow = {
  projectId: 1,
  modelId: 1,
  pinnedCommitSha: "a".repeat(40),
  pinnedCommitMessage: "Initial import",
  pinnedAt: new Date(),
  printedAt: null,
};

describe("toPinnedModel", () => {
  it("is not outdated when the pinned sha matches the model's current sha", () => {
    expect(toPinnedModel(basePin, baseModel).isOutdated).toBe(false);
  });

  it("is outdated when the model has moved to a different sha", () => {
    const model = { ...baseModel, lastSyncedCommitSha: "b".repeat(40) };
    expect(toPinnedModel(basePin, model).isOutdated).toBe(true);
  });

  it("is not outdated when the model has no synced commit yet (null)", () => {
    const model = { ...baseModel, lastSyncedCommitSha: null };
    expect(toPinnedModel(basePin, model).isOutdated).toBe(false);
  });

  it("is not outdated when lastSyncedCommitSha is an empty string (e.g. legacy corrupted rows)", () => {
    const model = { ...baseModel, lastSyncedCommitSha: "" };
    expect(toPinnedModel(basePin, model).isOutdated).toBe(false);
  });

  it("maps printedAt to null when the pin isn't printed", () => {
    expect(toPinnedModel(basePin, baseModel).printedAt).toBeNull();
  });

  it("maps printedAt to a unix ms timestamp when the pin is printed", () => {
    const printedAt = new Date("2026-01-15T00:00:00.000Z");
    const pin = { ...basePin, printedAt };
    expect(toPinnedModel(pin, baseModel).printedAt).toBe(printedAt.getTime());
  });
});

function insertModel(db: DbClient, title: string): ModelRow {
  const now = new Date();
  return db
    .insert(modelsTable)
    .values({ fsId: randomUUID(), path: `/library/${title}`, title, createdAt: now, updatedAt: now })
    .returning()
    .get();
}

describe("setPinPrinted", () => {
  let db: DbClient;
  let projectId: number;
  let modelId: number;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);

    const now = new Date();
    const project = db
      .insert(projectsTable)
      .values({ title: "Bundle", createdAt: now, updatedAt: now })
      .returning()
      .get();
    projectId = project.id;

    const model = insertModel(db, "Widget");
    modelId = model.id;

    db.insert(projectModelPinsTable)
      .values({
        projectId,
        modelId,
        pinnedCommitSha: "a".repeat(40),
        pinnedCommitMessage: "Initial import",
        pinnedAt: now,
      })
      .run();
  });

  it("sets printedAt when marking a pin as printed", () => {
    const updated = setPinPrinted(db, projectId, modelId, true);
    expect(updated?.printedAt).toBeInstanceOf(Date);
  });

  it("clears printedAt back to null when marking a pin as not printed", () => {
    setPinPrinted(db, projectId, modelId, true);
    const updated = setPinPrinted(db, projectId, modelId, false);
    expect(updated?.printedAt).toBeNull();
  });

  it("returns undefined when the model isn't pinned to the project", () => {
    const updated = setPinPrinted(db, projectId, 999_999, true);
    expect(updated).toBeUndefined();
  });
});
