import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import multipart from "@fastify/multipart";
import type { UserRole } from "@model-hub/shared";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAuthGuard } from "../../auth/guard.js";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { models as modelsTable, type ModelRow } from "../../db/schema.js";
import { ensureMarkerId } from "../../lib/fs-utils.js";
import { buildTestConfig } from "../../test-support/config.js";
import { getLog, getStatus } from "../../sync/git.js";
import { AUTO_SYNC_IDENTITY, LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
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

describe("POST /api/models/:id/upload — changesets, baseSha and staging", () => {
  let libraryRoot: string;
  let db: DbClient;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-changeset-"));
    db = createDbClient(":memory:");
    runMigrations(db);
  });

  afterEach(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
  });

  /** Same as buildTestApp, but with the real auth guard (single-user mode: admin local owner) so role checks see a user. */
  function buildGuardedApp(roleOverride?: UserRole): FastifyInstance {
    const app = Fastify({ logger: false });
    app.register(multipart);
    const config = buildTestConfig();
    registerAuthGuard(app, db, config);
    if (roleOverride) {
      app.addHook("onRequest", async (request) => {
        if (request.user) request.user = { ...request.user, role: roleOverride };
      });
    }
    registerModelRoutes(app, db, libraryRoot, config);
    registerVersionRoutes(app, db, config);
    return app;
  }

  function changesetForm(opts: {
    files?: Record<string, string>;
    deletes?: string[];
    baseSha?: string;
    message?: string;
  }): FormData {
    const form = new FormData();
    if (opts.message !== undefined) form.append("message", opts.message);
    if (opts.baseSha !== undefined) form.append("baseSha", opts.baseSha);
    for (const path of opts.deletes ?? []) form.append("delete", path);
    for (const [name, content] of Object.entries(opts.files ?? {})) {
      form.append("files", new Blob([content]), name);
    }
    return form;
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path)
      .then(() => true)
      .catch(() => false);
  }

  it("commits uploads and deletes as a single version and returns the new headSha", async () => {
    const app = buildGuardedApp();
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n", "b.stl": "b1\n" });
    const logBefore = await getLog(model.path);

    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ files: { "a.stl": "a2\n", "c.stl": "c1\n" }, deletes: ["b.stl"] }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      committed: boolean;
      writtenFiles: string[];
      deletedFiles: string[];
      headSha: string;
    };
    expect(body.committed).toBe(true);
    expect(body.writtenFiles).toEqual(["a.stl", "c.stl"]);
    expect(body.deletedFiles).toEqual(["b.stl"]);

    const logAfter = await getLog(model.path);
    expect(logAfter).toHaveLength(logBefore.length + 1);
    expect(logAfter[0]!.sha).toBe(body.headSha);
    expect(logAfter[0]!.message).toBe("Uploaded a.stl, c.stl; deleted b.stl");
    expect(await readFile(join(model.path, "a.stl"), "utf8")).toBe("a2\n");
    expect(await exists(join(model.path, "b.stl"))).toBe(false);

    const row = db.select().from(modelsTable).where(eq(modelsTable.id, model.id)).get()!;
    expect(row.lastSyncedCommitSha).toBe(body.headSha);
    await app.close();
  });

  it("leaves no staging leftovers behind and nothing uncommitted in the working tree", async () => {
    const app = buildGuardedApp();
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n" });

    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ files: { "new.stl": "n\n" } }),
    });
    expect(res.statusCode).toBe(200);

    const stagingRoot = join(model.path, ".git", "modelhub-staging");
    const leftovers = (await exists(stagingRoot)) ? await readdir(stagingRoot) : [];
    expect(leftovers).toEqual([]);
    expect((await getStatus(model.path)).isClean).toBe(true);
    await app.close();
  });

  it("accepts a matching baseSha, including an abbreviated one", async () => {
    const app = buildGuardedApp();
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n" });

    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ files: { "a.stl": "a2\n" }, baseSha: model.lastSyncedCommitSha!.slice(0, 7) }),
    });

    expect(res.statusCode).toBe(200);
    expect(await readFile(join(model.path, "a.stl"), "utf8")).toBe("a2\n");
    await app.close();
  });

  it("refuses a stale baseSha with 409 and writes nothing", async () => {
    const app = buildGuardedApp();
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n" });
    const staleSha = model.lastSyncedCommitSha!;
    const updated = await commitChange(db, model, (dir) => writeFile(join(dir, "a.stl"), "a2\n"), "Someone else");

    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ files: { "a.stl": "agent\n", "extra.stl": "x\n" }, baseSha: staleSha }),
    });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { baseSha: string; headSha: string };
    expect(body.baseSha).toBe(staleSha);
    expect(body.headSha).toBe(updated.lastSyncedCommitSha);
    expect(await readFile(join(model.path, "a.stl"), "utf8")).toBe("a2\n");
    expect(await exists(join(model.path, "extra.stl"))).toBe(false);
    expect((await getLog(model.path))[0]!.sha).toBe(updated.lastSyncedCommitSha);
    await app.close();
  });

  it("treats an uncommitted on-disk edit as a conflict, committing it as auto-sync first", async () => {
    const app = buildGuardedApp();
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n" });
    const baseSha = model.lastSyncedCommitSha!;
    // Edited over the share, not yet picked up by the watcher/scanner.
    await writeFile(join(model.path, "a.stl"), "edited on disk\n");

    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ files: { "a.stl": "agent\n" }, baseSha }),
    });

    expect(res.statusCode).toBe(409);
    expect(await readFile(join(model.path, "a.stl"), "utf8")).toBe("edited on disk\n");
    const [latest] = await getLog(model.path);
    expect(latest!.sha).not.toBe(baseSha);
    expect(latest!.authorName).toBe(AUTO_SYNC_IDENTITY.name);
    await app.close();
  });

  it("rejects an invalid baseSha", async () => {
    const app = buildGuardedApp();
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n" });

    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ files: { "a.stl": "a2\n" }, baseSha: "not-a-sha" }),
    });

    expect(res.statusCode).toBe(400);
    expect(await readFile(join(model.path, "a.stl"), "utf8")).toBe("a1\n");
    await app.close();
  });

  it("supports a delete-only changeset", async () => {
    const app = buildGuardedApp();
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n", "b.stl": "b1\n" });

    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ deletes: ["b.stl"] }),
    });

    expect(res.statusCode).toBe(200);
    expect(await exists(join(model.path, "b.stl"))).toBe(false);
    expect((await getLog(model.path))[0]!.message).toBe("Deleted b.stl");
    await app.close();
  });

  it("applies nothing when a file to delete does not exist", async () => {
    const app = buildGuardedApp();
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n" });

    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ files: { "a.stl": "a2\n" }, deletes: ["gone.stl"] }),
    });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { missingFiles: string[] }).missingFiles).toEqual(["gone.stl"]);
    expect(await readFile(join(model.path, "a.stl"), "utf8")).toBe("a1\n");
    await app.close();
  });

  it.each([["../other/a.stl"], [".modelhub-id"], [".git/config"], ["notes.txt"], ["/etc/passwd.stl"]])(
    "rejects unsafe delete path %s",
    async (path) => {
      const app = buildGuardedApp();
      const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n" });

      const res = await app.inject({
        method: "POST",
        url: `/api/models/${model.id}/upload`,
        payload: changesetForm({ deletes: [path] }),
      });

      expect(res.statusCode).toBe(400);
      expect(await exists(join(model.path, ".modelhub-id"))).toBe(true);
      await app.close();
    },
  );

  it("rejects uploading and deleting the same file in one request", async () => {
    const app = buildGuardedApp();
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n" });

    const res = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ files: { "a.stl": "a2\n" }, deletes: ["a.stl"] }),
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("requires the admin role to delete, but not to upload", async () => {
    const app = buildGuardedApp("editor");
    const model = await createTestModel(db, libraryRoot, "Widget", { "a.stl": "a1\n", "b.stl": "b1\n" });

    const deleteRes = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ files: { "a.stl": "a2\n" }, deletes: ["b.stl"] }),
    });
    expect(deleteRes.statusCode).toBe(403);
    expect(await exists(join(model.path, "b.stl"))).toBe(true);
    expect(await readFile(join(model.path, "a.stl"), "utf8")).toBe("a1\n");

    const uploadRes = await app.inject({
      method: "POST",
      url: `/api/models/${model.id}/upload`,
      payload: changesetForm({ files: { "a.stl": "a2\n" } }),
    });
    expect(uploadRes.statusCode).toBe(200);
    await app.close();
  });
});
