import { describe, expect, it } from "vitest";
import type { ModelRow, ProjectModelPinRow } from "../db/schema.js";
import { toPinnedModel } from "./project-pins.js";

const baseModel: ModelRow = {
  id: 1,
  fsId: "fs-id",
  path: "/library/some-model",
  title: "Some Model",
  description: "",
  primaryFilePath: "model.stl",
  thumbnailPath: null,
  thumbnailStatus: "ready",
  lastSyncedCommitSha: "a".repeat(40),
  lastSyncedAt: new Date(),
  syncStatus: "ok",
  syncError: null,
  missingSince: null,
  favorite: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const basePin: ProjectModelPinRow = {
  projectId: 1,
  modelId: 1,
  pinnedCommitSha: "a".repeat(40),
  pinnedCommitMessage: "Initial import",
  pinnedAt: new Date(),
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
});
