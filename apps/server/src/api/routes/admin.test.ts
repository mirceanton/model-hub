import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../auth/constants.js";
import { createSession } from "../../auth/session.js";
import type { Config } from "../../config.js";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import {
  personalAccessTokens as tokensTable,
  sessions as sessionsTable,
  users as usersTable,
  type UserRow,
} from "../../db/schema.js";
import { buildApp } from "../app.js";

// oidcAdminGroups/etc. don't matter here -- only `oidc` truthiness and
// sessionSecret drive registerAuthGuard's mode, same as api-tokens.test.ts.
const OIDC_CONFIG: Config = {
  libraryRoot: "/tmp/unused",
  databasePath: ":memory:",
  port: 4000,
  libraryScanIntervalMs: 60_000,
  syncDebounceMs: 5_000,
  libraryWatchEnabled: false,
  libraryWatchUsePolling: false,
  logLevel: "fatal",
  webBaseUrl: "http://localhost:4000",
  thumbnailConcurrency: 1,
  staticWebDir: null,
  oidc: {
    issuerUrl: "https://idp.example.com",
    clientId: "model-hub",
    clientSecret: "secret",
    redirectUrl: "http://localhost:4000/auth/callback",
  },
  sessionSecret: "a".repeat(32),
  oidcAdminGroups: [],
  authRateLimitMax: 1000,
  authRateLimitWindowMs: 60_000,
  uploadRateLimitMax: 1000,
  uploadRateLimitWindowMs: 60_000,
};

function insertUser(db: DbClient, overrides: Partial<typeof usersTable.$inferInsert> = {}): UserRow {
  const now = new Date();
  return db
    .insert(usersTable)
    .values({ role: "editor", createdAt: now, updatedAt: now, ...overrides })
    .returning()
    .get();
}

function sessionCookie(app: FastifyInstance, db: DbClient, userId: number): Record<string, string> {
  const session = createSession(db, userId);
  return { [SESSION_COOKIE_NAME]: app.signCookie(session.id) };
}

describe("DELETE /api/admin/users/:id", () => {
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildApp(db, OIDC_CONFIG);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("deletes another user and cascades their sessions/tokens", async () => {
    const admin = insertUser(db, { role: "admin", oidcSubject: "admin-sub" });
    const target = insertUser(db, { role: "viewer", oidcSubject: "target-sub" });
    createSession(db, target.id);
    db.insert(tokensTable)
      .values({ userId: target.id, tokenHash: "hash", label: "script", createdAt: new Date() })
      .run();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${target.id}`,
      cookies: sessionCookie(app, db, admin.id),
    });

    expect(res.statusCode).toBe(204);
    expect(db.select().from(usersTable).where(eq(usersTable.id, target.id)).get()).toBeUndefined();
    expect(db.select().from(sessionsTable).where(eq(sessionsTable.userId, target.id)).all()).toHaveLength(0);
    expect(db.select().from(tokensTable).where(eq(tokensTable.userId, target.id)).all()).toHaveLength(0);
  });

  it("blocks deleting your own account", async () => {
    const admin = insertUser(db, { role: "admin", oidcSubject: "admin-sub" });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${admin.id}`,
      cookies: sessionCookie(app, db, admin.id),
    });

    expect(res.statusCode).toBe(400);
    expect(db.select().from(usersTable).where(eq(usersTable.id, admin.id)).get()).toBeDefined();
  });

  it("blocks deleting the local owner row", async () => {
    const admin = insertUser(db, { role: "admin", oidcSubject: "admin-sub" });
    // isLocalOwner rows only exist in single-user mode in real operation --
    // inserted directly here to exercise the guard defensively (see
    // admin.ts's DELETE handler, same "defense in depth" reasoning as
    // guard.ts's requireRole).
    const localOwner = insertUser(db, { role: "admin", isLocalOwner: true, oidcSubject: null });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${localOwner.id}`,
      cookies: sessionCookie(app, db, admin.id),
    });

    expect(res.statusCode).toBe(400);
    expect(db.select().from(usersTable).where(eq(usersTable.id, localOwner.id)).get()).toBeDefined();
  });

  it("404s for a nonexistent user", async () => {
    const admin = insertUser(db, { role: "admin", oidcSubject: "admin-sub" });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/users/999999",
      cookies: sessionCookie(app, db, admin.id),
    });

    expect(res.statusCode).toBe(404);
  });

  it("400s on a non-numeric id", async () => {
    const admin = insertUser(db, { role: "admin", oidcSubject: "admin-sub" });

    const res = await app.inject({
      method: "DELETE",
      url: "/api/admin/users/not-a-number",
      cookies: sessionCookie(app, db, admin.id),
    });

    expect(res.statusCode).toBe(400);
  });

  it("403s for an authenticated non-admin", async () => {
    const editor = insertUser(db, { role: "editor", oidcSubject: "editor-sub" });
    const target = insertUser(db, { role: "viewer", oidcSubject: "target-sub" });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${target.id}`,
      cookies: sessionCookie(app, db, editor.id),
    });

    expect(res.statusCode).toBe(403);
  });
});
