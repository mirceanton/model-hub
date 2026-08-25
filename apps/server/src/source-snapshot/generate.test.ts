import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { models as modelsTable, type ModelRow } from "../db/schema.js";
import * as safeFetch from "../lib/safe-fetch.js";
import { generateSourceSnapshot } from "./generate.js";

function insertModel(db: DbClient, sourceUrl: string | null): ModelRow {
  const now = new Date();
  return db
    .insert(modelsTable)
    .values({
      fsId: randomUUID(),
      path: `/library/model-${randomUUID()}`,
      title: "Some Model",
      sourceUrl,
      sourceSnapshotStatus: sourceUrl ? "pending" : "none",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

describe("generateSourceSnapshot", () => {
  let db: DbClient;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores the sanitized HTML and marks the snapshot ready on a successful fetch", async () => {
    const model = insertModel(db, "https://example.com/thing/123");
    vi.spyOn(safeFetch, "fetchUrlSafely").mockResolvedValue({
      ok: true,
      status: 200,
      contentType: "text/html",
      body: '<p>hi</p><script>alert(1)</script>',
      truncated: false,
    });

    await generateSourceSnapshot(db, model);

    const updated = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    expect(updated.sourceSnapshotStatus).toBe("ready");
    expect(updated.sourceSnapshotHtml).toContain("<p>hi</p>");
    expect(updated.sourceSnapshotHtml).not.toContain("<script");
    expect(updated.sourceSnapshotError).toBeNull();
    expect(updated.sourceSnapshotFetchedAt).toBeInstanceOf(Date);
  });

  it("records a terminal error state without throwing when the fetch fails", async () => {
    const model = insertModel(db, "https://example.com/thing/123");
    vi.spyOn(safeFetch, "fetchUrlSafely").mockResolvedValue({
      ok: false,
      error: "blocked: 10.0.0.5 is not a public address",
    });

    await expect(generateSourceSnapshot(db, model)).resolves.toBeUndefined();

    const updated = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    expect(updated.sourceSnapshotStatus).toBe("error");
    expect(updated.sourceSnapshotError).toMatch(/not a public address/);
    expect(updated.sourceSnapshotHtml).toBeNull();
  });

  it("never rejects even if fetchUrlSafely itself throws", async () => {
    const model = insertModel(db, "https://example.com/thing/123");
    vi.spyOn(safeFetch, "fetchUrlSafely").mockRejectedValue(new Error("boom"));

    await expect(generateSourceSnapshot(db, model)).resolves.toBeUndefined();

    const updated = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    expect(updated.sourceSnapshotStatus).toBe("error");
    expect(updated.sourceSnapshotError).toBe("boom");
  });

  it("clears any stored snapshot when the model has no sourceUrl", async () => {
    const model = insertModel(db, null);
    db.update(modelsTable)
      .set({ sourceSnapshotHtml: "<p>stale</p>", sourceSnapshotStatus: "ready" })
      .where(eq(modelsTable.id, model.id))
      .run();

    await generateSourceSnapshot(db, { id: model.id, sourceUrl: null });

    const updated = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    expect(updated.sourceSnapshotStatus).toBe("none");
    expect(updated.sourceSnapshotHtml).toBeNull();
  });
});
