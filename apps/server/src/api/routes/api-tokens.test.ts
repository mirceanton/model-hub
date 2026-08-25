import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiToken, revokeApiToken } from "../../auth/api-tokens.js";
import { registerAuthGuard, requireRole } from "../../auth/guard.js";
import type { Config } from "../../config.js";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { users as usersTable, type UserRow } from "../../db/schema.js";
import { registerApiTokenRoutes } from "./api-tokens.js";

// A minimal OIDC-mode config -- only its `oidc` truthiness and sessionSecret
// matter to registerAuthGuard/the cookie plugin; nothing here actually
// drives a real OIDC handshake.
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
  authRateLimitMax: 10,
  authRateLimitWindowMs: 60_000,
  uploadRateLimitMax: 30,
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

function buildTestApp(db: DbClient): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie, { secret: OIDC_CONFIG.sessionSecret ?? undefined });
  registerAuthGuard(app, db, OIDC_CONFIG);
  registerApiTokenRoutes(app, db);

  // Stand-ins for "some protected route" and "some admin-only route" --
  // exercises that a bearer token flows through request.user/requireRole
  // exactly like a session does.
  app.get("/api/_whoami", async (request) => ({
    id: request.user!.id,
    role: request.user!.role,
  }));
  app.get("/api/_admin-only", { preHandler: requireRole("admin") }, async () => ({ ok: true }));

  return app;
}

describe("bearer token authentication (guard.ts)", () => {
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildTestApp(db);
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it("rejects a request to a protected route with no credentials", async () => {
    const res = await app.inject({ method: "GET", url: "/api/_whoami" });
    expect(res.statusCode).toBe(401);
  });

  it("authenticates as the token's owning user via Authorization: Bearer", async () => {
    const user = insertUser(db, { name: "Alice", role: "admin" });
    const { token } = createApiToken(db, user.id, "ci script");

    const res = await app.inject({
      method: "GET",
      url: "/api/_whoami",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: user.id, role: "admin" });
  });

  it("authenticates as the owning user's CURRENT role, not an elevated default", async () => {
    const viewer = insertUser(db, { role: "viewer" });
    const admin = insertUser(db, { role: "admin" });
    const viewerToken = createApiToken(db, viewer.id, "viewer script").token;
    const adminToken = createApiToken(db, admin.id, "admin script").token;

    const asViewer = await app.inject({
      method: "GET",
      url: "/api/_admin-only",
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(asViewer.statusCode).toBe(403);

    const asAdmin = await app.inject({
      method: "GET",
      url: "/api/_admin-only",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(asAdmin.statusCode).toBe(200);
  });

  it("rejects an unknown or malformed bearer token", async () => {
    const resUnknown = await app.inject({
      method: "GET",
      url: "/api/_whoami",
      headers: { authorization: `Bearer mh_pat_${"0".repeat(64)}` },
    });
    expect(resUnknown.statusCode).toBe(401);

    const resGarbage = await app.inject({
      method: "GET",
      url: "/api/_whoami",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(resGarbage.statusCode).toBe(401);
  });

  it("rejects an expired token", async () => {
    const user = insertUser(db);
    vi.useFakeTimers();
    try {
      const { token } = createApiToken(db, user.id, "temp", new Date(Date.now() + 1000));
      vi.advanceTimersByTime(2000);

      const res = await app.inject({
        method: "GET",
        url: "/api/_whoami",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a revoked token", async () => {
    const user = insertUser(db);
    const created = createApiToken(db, user.id, "ci");
    revokeApiToken(db, user.id, created.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/_whoami",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST/GET/DELETE /api/tokens", () => {
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

  function authHeader(userId: number, label = "auth"): { authorization: string } {
    const { token } = createApiToken(db, userId, label);
    return { authorization: `Bearer ${token}` };
  }

  it("creates a token and returns the plaintext exactly once", async () => {
    const user = insertUser(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: authHeader(user.id, "bootstrap"),
      payload: { label: "slicer hook" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.label).toBe("slicer hook");
    expect(body.token).toMatch(/^mh_pat_[0-9a-f]{64}$/);
    expect(body.lastUsedAt).toBeNull();
  });

  it("rejects creation with an empty label", async () => {
    const user = insertUser(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: authHeader(user.id),
      payload: { label: "  " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists a user's tokens without ever including the plaintext secret", async () => {
    const user = insertUser(db);
    const auth = authHeader(user.id, "listing-auth");
    await app.inject({ method: "POST", url: "/api/tokens", headers: auth, payload: { label: "one" } });
    await app.inject({ method: "POST", url: "/api/tokens", headers: auth, payload: { label: "two" } });

    const res = await app.inject({ method: "GET", url: "/api/tokens", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>[];

    // The token used to authenticate this very request plus the two created above.
    expect(body.length).toBe(3);
    for (const entry of body) {
      expect(entry).not.toHaveProperty("token");
      expect(entry).not.toHaveProperty("tokenHash");
    }
  });

  it("revokes a token, after which it can no longer authenticate", async () => {
    const user = insertUser(db);
    const auth = authHeader(user.id, "revoker");
    const createRes = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: auth,
      payload: { label: "to be revoked" },
    });
    const created = createRes.json() as { id: number; token: string };

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/tokens/${created.id}`,
      headers: auth,
    });
    expect(deleteRes.statusCode).toBe(204);

    const whoamiRes = await app.inject({
      method: "GET",
      url: "/api/_whoami",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(whoamiRes.statusCode).toBe(401);
  });

  it("404s revoking an unknown token id", async () => {
    const user = insertUser(db);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/tokens/999999",
      headers: authHeader(user.id),
    });
    expect(res.statusCode).toBe(404);
  });

  it("refuses to let one user revoke another user's token", async () => {
    const alice = insertUser(db);
    const bob = insertUser(db);
    const bobsToken = createApiToken(db, bob.id, "bob's token");

    const res = await app.inject({
      method: "DELETE",
      url: `/api/tokens/${bobsToken.id}`,
      headers: authHeader(alice.id, "alice's auth"),
    });
    expect(res.statusCode).toBe(404);

    // Still usable -- wasn't actually revoked.
    const whoamiRes = await app.inject({
      method: "GET",
      url: "/api/_whoami",
      headers: { authorization: `Bearer ${bobsToken.token}` },
    });
    expect(whoamiRes.statusCode).toBe(200);
  });
});
