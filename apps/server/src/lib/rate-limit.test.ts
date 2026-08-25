import cookie from "@fastify/cookie";
import rateLimitPlugin from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiToken } from "../auth/api-tokens.js";
import { registerAuthGuard } from "../auth/guard.js";
import type { Config } from "../config.js";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { users as usersTable, type UserRow } from "../db/schema.js";
import { buildTestConfig } from "../test-support/config.js";
import { authRateLimit, uploadRateLimit } from "./rate-limit.js";

function insertUser(db: DbClient, overrides: Partial<typeof usersTable.$inferInsert> = {}): UserRow {
  const now = new Date();
  return db
    .insert(usersTable)
    .values({ role: "editor", createdAt: now, updatedAt: now, ...overrides })
    .returning()
    .get();
}

describe("authRateLimit (per-IP)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const config = buildTestConfig({ authRateLimitMax: 3, authRateLimitWindowMs: 1000 });
    app = Fastify({ logger: false });
    await app.register(rateLimitPlugin, { global: false });
    // Stand-in for /auth/login etc. -- exercises authRateLimit's config in
    // isolation from the real OIDC handshake.
    app.get("/probe", { config: { rateLimit: authRateLimit(config) } }, async () => ({ ok: true }));
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it("allows up to the configured max requests from one IP, then 429s with Retry-After", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/probe", remoteAddress: "10.0.0.1" });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: "GET", url: "/probe", remoteAddress: "10.0.0.1" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("tracks separate IPs independently, so one caller can't exhaust another's budget", async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "GET", url: "/probe", remoteAddress: "10.0.0.2" });
    }
    const stillBlockedSameIp = await app.inject({ method: "GET", url: "/probe", remoteAddress: "10.0.0.2" });
    expect(stillBlockedSameIp.statusCode).toBe(429);

    const otherIp = await app.inject({ method: "GET", url: "/probe", remoteAddress: "10.0.0.3" });
    expect(otherIp.statusCode).toBe(200);
  });

  it("resets after the configured window elapses", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) {
        await app.inject({ method: "GET", url: "/probe", remoteAddress: "10.0.0.4" });
      }
      const blocked = await app.inject({ method: "GET", url: "/probe", remoteAddress: "10.0.0.4" });
      expect(blocked.statusCode).toBe(429);

      vi.advanceTimersByTime(1100);

      const afterReset = await app.inject({ method: "GET", url: "/probe", remoteAddress: "10.0.0.4" });
      expect(afterReset.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("uploadRateLimit (per-user)", () => {
  let db: DbClient;
  let app: FastifyInstance;

  function authHeader(userId: number, label = "test"): { authorization: string } {
    const { token } = createApiToken(db, userId, label);
    return { authorization: `Bearer ${token}` };
  }

  beforeEach(async () => {
    db = createDbClient(":memory:");
    runMigrations(db);

    // OIDC mode -- registerAuthGuard only enforces auth (401s an
    // unauthenticated /api/* request, sets request.user otherwise) when
    // OIDC is configured; single-user mode always resolves to the same
    // synthetic user and has nothing to test per-user isolation against.
    const config: Config = buildTestConfig({
      uploadRateLimitMax: 2,
      uploadRateLimitWindowMs: 1000,
      sessionSecret: "a".repeat(32),
      oidc: {
        issuerUrl: "https://idp.example.com",
        clientId: "model-hub",
        clientSecret: "secret",
        redirectUrl: "http://localhost:4000/auth/callback",
      },
    });

    app = Fastify({ logger: false });
    await app.register(cookie, { secret: config.sessionSecret ?? undefined });
    await app.register(rateLimitPlugin, { global: false });
    registerAuthGuard(app, db, config);
    // Stand-in for POST /api/models and POST /api/models/:id/upload --
    // under /api/ so the auth guard's 401 gate applies exactly like the
    // real routes.
    app.post("/api/probe-upload", { config: { rateLimit: uploadRateLimit(config) } }, async () => ({ ok: true }));
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it("never reaches the rate limiter on an unauthenticated request to a protected route", async () => {
    // Proves the hook-ordering assumption: uploadRateLimit runs as a
    // preHandler, which only fires after the auth guard's onRequest hook
    // has run to completion -- an unauthenticated request gets 401'd by
    // the guard and never consumes a rate-limit slot.
    const res = await app.inject({ method: "POST", url: "/api/probe-upload" });
    expect(res.statusCode).toBe(401);
  });

  it("allows up to the configured max requests for one user, then 429s with Retry-After", async () => {
    const user = insertUser(db);
    const headers = authHeader(user.id);

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "POST", url: "/api/probe-upload", headers });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: "POST", url: "/api/probe-upload", headers });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("tracks separate users independently, so one heavy uploader doesn't throttle everyone else", async () => {
    const alice = insertUser(db);
    const bob = insertUser(db);
    const aliceHeaders = authHeader(alice.id, "alice");

    for (let i = 0; i < 2; i++) {
      await app.inject({ method: "POST", url: "/api/probe-upload", headers: aliceHeaders });
    }
    const aliceBlocked = await app.inject({ method: "POST", url: "/api/probe-upload", headers: aliceHeaders });
    expect(aliceBlocked.statusCode).toBe(429);

    const bobHeaders = authHeader(bob.id, "bob");
    const bobStillOk = await app.inject({ method: "POST", url: "/api/probe-upload", headers: bobHeaders });
    expect(bobStillOk.statusCode).toBe(200);
  });

  it("resets after the configured window elapses", async () => {
    const user = insertUser(db);
    const headers = authHeader(user.id);

    vi.useFakeTimers();
    try {
      for (let i = 0; i < 2; i++) {
        await app.inject({ method: "POST", url: "/api/probe-upload", headers });
      }
      const blocked = await app.inject({ method: "POST", url: "/api/probe-upload", headers });
      expect(blocked.statusCode).toBe(429);

      vi.advanceTimersByTime(1100);

      const afterReset = await app.inject({ method: "POST", url: "/api/probe-upload", headers });
      expect(afterReset.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
