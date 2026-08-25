import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { models as modelsTable, type ModelRow } from "../../db/schema.js";
import { registerSourceSnapshotRoutes } from "./source-snapshot.js";

function buildTestApp(db: DbClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerSourceSnapshotRoutes(app, db);
  return app;
}

function insertModel(db: DbClient, dir: string, sourceUrl: string | null): ModelRow {
  const now = new Date();
  return db
    .insert(modelsTable)
    .values({
      fsId: "fs-id",
      path: join(dir, "Model"),
      title: "Model",
      sourceUrl,
      sourceSnapshotStatus: sourceUrl ? "ready" : "none",
      sourceSnapshotHtml: sourceUrl ? "<p>old snapshot</p>" : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

describe("POST /api/models/:id/source-snapshot/refresh", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-snapshot-refresh-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildTestApp(db);
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("404s for an unknown model", async () => {
    const res = await app.inject({ method: "POST", url: "/api/models/999/source-snapshot/refresh" });
    expect(res.statusCode).toBe(404);
  });

  it("400s when the model has no sourceUrl", async () => {
    const model = insertModel(db, libraryRoot, null);
    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/source-snapshot/refresh`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("sourceUrl") });
  });

  it("marks the snapshot pending and queues a re-fetch when sourceUrl is set", async () => {
    const model = insertModel(db, libraryRoot, "https://example.com/thing/1");
    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/source-snapshot/refresh`,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ok: true, sourceSnapshotStatus: "pending" });

    const updated = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    expect(updated.sourceSnapshotStatus).toBe("pending");
    expect(updated.sourceSnapshotError).toBeNull();
  });
});
