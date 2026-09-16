import type { Project } from "@model-hub/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { registerProjectRoutes } from "./projects.js";

/**
 * Archiving is a DB-only, non-destructive "hide from the default view but
 * keep everything" flag (see CLAUDE.md's Projects section and
 * schema.ts's projects.archivedAt doc comment) — no filesystem/git, no
 * auth gating, so a bare app with just the project routes registered is
 * enough here. Bulk archive/unarchive (POST /api/projects/bulk) is covered
 * alongside the rest of that gated route's tests in bulk.test.ts instead,
 * since it needs the real auth guard wired in for requireRole("editor").
 */
function buildTestApp(db: DbClient): FastifyInstance {
  const app = Fastify({ logger: false });
  registerProjectRoutes(app, db);
  return app;
}

async function createProject(app: FastifyInstance, title: string): Promise<Project> {
  const res = await app.inject({ method: "POST", url: "/api/projects", payload: { title } });
  return res.json() as Project;
}

describe("project archiving", () => {
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildTestApp(db);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/projects", () => {
    it("excludes archived projects by default", async () => {
      const active = await createProject(app, "Active");
      const archived = await createProject(app, "Archived");
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${archived.id}`,
        payload: { archived: true },
      });

      const res = await app.inject({ method: "GET", url: "/api/projects" });
      const body = res.json() as Project[];
      expect(body.map((p) => p.id)).toEqual([active.id]);
    });

    it("?archived=true shows only archived projects", async () => {
      const active = await createProject(app, "Active");
      const archived = await createProject(app, "Archived");
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${archived.id}`,
        payload: { archived: true },
      });
      void active;

      const res = await app.inject({ method: "GET", url: "/api/projects?archived=true" });
      const body = res.json() as Project[];
      expect(body.map((p) => p.id)).toEqual([archived.id]);
    });
  });

  describe("PATCH /api/projects/:id", () => {
    it("sets archivedAt when archived: true, and clears it when archived: false", async () => {
      const project = await createProject(app, "Alpha");
      expect(project.archivedAt).toBeNull();

      const archiveRes = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { archived: true },
      });
      const archived = archiveRes.json() as Project;
      expect(archived.archivedAt).not.toBeNull();

      const unarchiveRes = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { archived: false },
      });
      const unarchived = unarchiveRes.json() as Project;
      expect(unarchived.archivedAt).toBeNull();
    });

    it("leaves archivedAt untouched when the field is omitted", async () => {
      const project = await createProject(app, "Alpha");
      await app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, payload: { archived: true } });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { title: "Alpha renamed" },
      });
      const updated = res.json() as Project;
      expect(updated.title).toBe("Alpha renamed");
      expect(updated.archivedAt).not.toBeNull();
    });

    it("an archived project stays individually viewable and editable", async () => {
      const project = await createProject(app, "Alpha");
      await app.inject({ method: "PATCH", url: `/api/projects/${project.id}`, payload: { archived: true } });

      const getRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}` });
      expect(getRes.statusCode).toBe(200);

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}`,
        payload: { description: "still editable" },
      });
      expect(patchRes.statusCode).toBe(200);
      expect((patchRes.json() as Project).description).toBe("still editable");
    });
  });
});
