import { mkdir, mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
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
import { buildTestConfig } from "../../test-support/config.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { registerModelRoutes } from "./models.js";
import { registerVersionRoutes } from "./versions.js";

function buildTestApp(db: DbClient, libraryRoot: string): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(multipart);
  registerModelRoutes(app, db, libraryRoot, buildTestConfig());
  registerVersionRoutes(app, db, buildTestConfig());
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

async function commitChange(
  db: DbClient,
  model: ModelRow,
  mutate: (dirPath: string) => Promise<void>,
  commitMessage: string,
): Promise<ModelRow> {
  await mutate(model.path);
  await reconcileModelCore(db, model, { identity: LOCAL_UPLOAD_IDENTITY, commitMessage });
  return db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
}

describe("GET /api/models/:id/diff", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-diff-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildTestApp(db, libraryRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("returns the intervening commit log and a file-level add/modify/remove change list", async () => {
    const model = await createTestModel(db, libraryRoot, "Widget", {
      "a.stl": "solid a-v1\nendsolid a-v1\n",
      "b.stl": "solid b\nendsolid b\n",
    });
    const v1Sha = model.lastSyncedCommitSha!;

    // v2: modify a.stl, remove b.stl, add c.stl
    const updated = await commitChange(
      db,
      model,
      async (dirPath) => {
        await writeFile(join(dirPath, "a.stl"), "solid a-v2\nendsolid a-v2\n", "utf8");
        await unlink(join(dirPath, "b.stl"));
        await writeFile(join(dirPath, "c.stl"), "solid c\nendsolid c\n", "utf8");
      },
      "Update a, remove b, add c",
    );
    const v2Sha = updated.lastSyncedCommitSha!;
    expect(v2Sha).not.toBe(v1Sha);

    const res = await app.inject({
      method: "GET",
      url: `/api/models/${model.id}/diff?from=${v1Sha}&to=${v2Sha}`,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      commits: { sha: string; message: string }[];
      files: { path: string; status: string }[];
    };

    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]).toMatchObject({ sha: v2Sha, message: "Update a, remove b, add c" });

    const byPath = Object.fromEntries(body.files.map((f) => [f.path, f.status]));
    expect(byPath).toEqual({
      "a.stl": "modified",
      "b.stl": "removed",
      "c.stl": "added",
    });
  });

  it("reports multiple intervening commits between older and newer shas, oldest exclusive", async () => {
    const model = await createTestModel(db, libraryRoot, "Multi", { "a.stl": "v1\n" });
    const v1Sha = model.lastSyncedCommitSha!;

    const v2 = await commitChange(db, model, (dir) => writeFile(join(dir, "a.stl"), "v2\n", "utf8"), "v2");
    const v3 = await commitChange(db, model, (dir) => writeFile(join(dir, "a.stl"), "v3\n", "utf8"), "v3");
    const v3Sha = v3.lastSyncedCommitSha!;

    const res = await app.inject({
      method: "GET",
      url: `/api/models/${model.id}/diff?from=${v1Sha}&to=${v3Sha}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { commits: { sha: string }[] };
    expect(body.commits.map((c) => c.sha)).toEqual([v3Sha, v2.lastSyncedCommitSha!]);
  });

  it("returns the same commits and an empty-vs-reversed-status diff regardless of from/to direction", async () => {
    const model = await createTestModel(db, libraryRoot, "Rollback", { "a.stl": "v1\n" });
    const v1Sha = model.lastSyncedCommitSha!;
    const v2 = await commitChange(db, model, (dir) => writeFile(join(dir, "a.stl"), "v2\n", "utf8"), "v2");
    const v2Sha = v2.lastSyncedCommitSha!;

    const forward = await app.inject({
      method: "GET",
      url: `/api/models/${model.id}/diff?from=${v1Sha}&to=${v2Sha}`,
    });
    const backward = await app.inject({
      method: "GET",
      url: `/api/models/${model.id}/diff?from=${v2Sha}&to=${v1Sha}`,
    });

    const forwardBody = forward.json() as { commits: { sha: string }[]; files: { status: string }[] };
    const backwardBody = backward.json() as { commits: { sha: string }[]; files: { status: string }[] };

    // Same set of intervening commits regardless of direction.
    expect(forwardBody.commits.map((c) => c.sha)).toEqual(backwardBody.commits.map((c) => c.sha));
    expect(forwardBody.files).toEqual([{ path: "a.stl", status: "modified" }]);
    expect(backwardBody.files).toEqual([{ path: "a.stl", status: "modified" }]);
  });

  it("rejects an unknown from sha", async () => {
    const model = await createTestModel(db, libraryRoot, "BadFrom", { "a.stl": "v1\n" });
    const sha = model.lastSyncedCommitSha!;

    const res = await app.inject({
      method: "GET",
      url: `/api/models/${model.id}/diff?from=deadbeef00000000000000000000000000000000&to=${sha}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("not a known commit") });
  });

  it("rejects an unknown to sha", async () => {
    const model = await createTestModel(db, libraryRoot, "BadTo", { "a.stl": "v1\n" });
    const sha = model.lastSyncedCommitSha!;

    const res = await app.inject({
      method: "GET",
      url: `/api/models/${model.id}/diff?from=${sha}&to=deadbeef00000000000000000000000000000000`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("not a known commit") });
  });

  it("400s when from or to is missing", async () => {
    const model = await createTestModel(db, libraryRoot, "Missing", { "a.stl": "v1\n" });
    const sha = model.lastSyncedCommitSha!;

    const noTo = await app.inject({ method: "GET", url: `/api/models/${model.id}/diff?from=${sha}` });
    expect(noTo.statusCode).toBe(400);

    const noFrom = await app.inject({ method: "GET", url: `/api/models/${model.id}/diff?to=${sha}` });
    expect(noFrom.statusCode).toBe(400);
  });

  it("404s for a model that doesn't exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/models/999999/diff?from=a&to=b" });
    expect(res.statusCode).toBe(404);
  });

  it("404s for a trashed model (stricter than project export's unfiltered lookup — no caller needs it reachable)", async () => {
    const model = await createTestModel(db, libraryRoot, "Trashed", { "a.stl": "v1\n" });
    const sha = model.lastSyncedCommitSha!;

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/models/${model.id}` });
    expect(deleteRes.statusCode).toBe(204);

    const res = await app.inject({
      method: "GET",
      url: `/api/models/${model.id}/diff?from=${sha}&to=${sha}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/models/:id/upload", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-upload-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildTestApp(db, libraryRoot);
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("includes skippedFiles in the 400 response when no file has a trackable extension", async () => {
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "v1\n" });

    const form = new FormData();
    form.append("files", new Blob(["hi"]), "notes.txt");

    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: form,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; skippedFiles: string[] };
    expect(body.error).toContain("no valid model or attachment files");
    expect(body.skippedFiles).toEqual(["notes.txt"]);
  });
});
