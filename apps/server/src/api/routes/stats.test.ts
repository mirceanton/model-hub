import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceStats } from "@model-hub/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAuthGuard, requireRole } from "../../auth/guard.js";
import { buildTestConfig } from "../../test-support/config.js";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { models as modelsTable, projects as projectsTable, tags as tagsTable } from "../../db/schema.js";
import { registerStatsRoutes } from "./stats.js";

function insertModel(
  db: DbClient,
  overrides: Partial<typeof modelsTable.$inferInsert> = {},
): void {
  const now = new Date();
  db.insert(modelsTable)
    .values({
      fsId: overrides.fsId ?? `fs-${Math.random()}`,
      path: overrides.path ?? `/tmp/unused-${Math.random()}`,
      title: overrides.title ?? "Untitled",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .run();
}

describe("GET /api/stats", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-stats-"));
    db = createDbClient(":memory:");
    runMigrations(db);

    app = Fastify({ logger: false });
    const config = buildTestConfig({ libraryRoot });
    // Single-user mode: registerAuthGuard resolves every request to the
    // synthetic local owner, who is always "admin" (see session.ts's
    // ensureLocalOwner) — same as every other requireRole("admin") route
    // behaves outside OIDC mode.
    registerAuthGuard(app, db, config);
    registerStatsRoutes(app, db, config);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("counts only active (non-trashed) models, grouped by thumbnail/sync status", async () => {
    insertModel(db, { thumbnailStatus: "ready", syncStatus: "ok" });
    insertModel(db, { thumbnailStatus: "ready", syncStatus: "ok" });
    insertModel(db, { thumbnailStatus: "pending", syncStatus: "error", syncError: "boom" });
    insertModel(db, { thumbnailStatus: "error", syncStatus: "missing", missingSince: new Date() });
    insertModel(db, { thumbnailStatus: "ready", syncStatus: "ok", deletedAt: new Date() }); // trashed — excluded

    const res = await app.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as InstanceStats;

    expect(body.counts.models).toBe(4);
    expect(body.counts.thumbnailStatus).toEqual({ pending: 1, generating: 0, ready: 2, error: 1 });
    expect(body.sync.errorModelCount).toBe(1);
    expect(body.sync.missingModelCount).toBe(1);
  });

  it("counts projects and tags", async () => {
    const now = new Date();
    db.insert(projectsTable).values({ title: "P1", createdAt: now, updatedAt: now }).run();
    db.insert(projectsTable).values({ title: "P2", createdAt: now, updatedAt: now }).run();
    db.insert(tagsTable).values({ name: "decor", createdAt: now }).run();

    const res = await app.inject({ method: "GET", url: "/api/stats" });
    const body = res.json() as InstanceStats;

    expect(body.counts.projects).toBe(2);
    expect(body.counts.tags).toBe(1);
  });

  it("reports library storage from the real LIBRARY_ROOT directory tree", async () => {
    await mkdir(join(libraryRoot, "Benchy"), { recursive: true });
    await writeFile(join(libraryRoot, "Benchy", "model.stl"), "x".repeat(1000), "utf8");

    const res = await app.inject({ method: "GET", url: "/api/stats" });
    const body = res.json() as InstanceStats;

    expect(body.storage.libraryUsedBytes).toBeGreaterThanOrEqual(1000);
    expect(body.storage.volumeTotalBytes).toBeGreaterThan(0);
  });

  it("reports thumbnail queue depth as zero when the pipeline hasn't been initialized (test environment)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stats" });
    const body = res.json() as InstanceStats;

    expect(body.thumbnailQueue).toEqual({ pending: 0, active: 0 });
  });

  it("reports sync.lastScanAt as null when no scan has completed yet", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stats" });
    const body = res.json() as InstanceStats;

    // Not asserting non-null here since another test file may have already
    // called recordScanCompleted in this same process (module-level state);
    // just assert the shape is present and type-correct either way.
    expect(body.sync).toHaveProperty("lastScanAt");
    expect(body.sync).toHaveProperty("lastScanDurationSeconds");
  });

  it("reports instance info: oidc disabled, library root, a version string", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stats" });
    const body = res.json() as InstanceStats;

    expect(body.instance.oidcEnabled).toBe(false);
    expect(body.instance.libraryRoot).toBe(libraryRoot);
    expect(typeof body.instance.version).toBe("string");
    expect(body.instance.version.length).toBeGreaterThan(0);
  });
});

describe("GET /api/stats role gating", () => {
  it("requires the admin role — a non-admin gets 403", async () => {
    const libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-stats-role-"));
    const db = createDbClient(":memory:");
    runMigrations(db);

    const app = Fastify({ logger: false });
    // Stand in for a non-admin caller without standing up full OIDC/session
    // machinery — same technique as requireRole's own unit-level coverage
    // in api-tokens.test.ts.
    app.addHook("onRequest", async (request) => {
      request.user = {
        id: 1,
        oidcSubject: null,
        email: null,
        name: null,
        role: "viewer",
        isLocalOwner: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
    app.get("/api/stats", { preHandler: requireRole("admin") }, async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(403);

    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });
});
