import { describe, expect, it } from "vitest";
import { createDbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { buildTestConfig } from "../test-support/config.js";
import { buildApp } from "./app.js";

/**
 * End-to-end (real buildApp, not a single route module in isolation) checks
 * for the OpenAPI wiring added for issue #70. Two things specifically worth
 * a real boot rather than just reading the code:
 *
 *  - @fastify/swagger's `onRoute` hook only sees routes declared *after* it
 *    finishes registering. Every route module in this app is registered via
 *    a plain function call (`registerModelRoutes(app, ...)`), not wrapped in
 *    its own `app.register()` — those calls run synchronously, in the same
 *    tick, well before any `app.register()`'d plugin (swagger included)
 *    actually executes, since `register()` always defers to avvio's boot
 *    phase. Without deliberately wrapping the route modules in their own
 *    `app.register()` in app.ts (queueing them after swagger's), the
 *    generated spec would silently have zero paths — this isn't
 *    hypothetical, it's what happened during development until that wrapping
 *    was added.
 *  - /docs and /docs/json live outside `/api/`, so auth/guard.ts had to
 *    explicitly extend its protected-route check to cover them — this test
 *    is what would catch a future refactor accidentally dropping that.
 */
describe("openapi wiring (issue #70)", () => {
  it("serves /docs and /docs/json unauthenticated in single-user mode", async () => {
    const db = createDbClient(":memory:");
    runMigrations(db);
    const app = buildApp(db, buildTestConfig());
    await app.ready();

    const docs = await app.inject({ method: "GET", url: "/docs" });
    expect(docs.statusCode).toBe(200);

    const json = await app.inject({ method: "GET", url: "/docs/json" });
    expect(json.statusCode).toBe(200);
    const spec = json.json();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(30);
    expect(spec.paths["/api/models"]).toBeDefined();
    expect(spec.paths["/api/tags"]).toBeDefined();

    await app.close();
  });

  it("401s /docs and /docs/json without a session in OIDC mode, and still serves /healthz", async () => {
    const db = createDbClient(":memory:");
    runMigrations(db);
    const app = buildApp(
      db,
      buildTestConfig({
        oidc: {
          issuerUrl: "https://idp.example.com",
          clientId: "model-hub",
          clientSecret: "secret",
          redirectUrl: "http://localhost:4000/auth/callback",
        },
        sessionSecret: "a".repeat(32),
      }),
    );
    await app.ready();

    const docs = await app.inject({ method: "GET", url: "/docs" });
    expect(docs.statusCode).toBe(401);

    const json = await app.inject({ method: "GET", url: "/docs/json" });
    expect(json.statusCode).toBe(401);

    const api = await app.inject({ method: "GET", url: "/api/models" });
    expect(api.statusCode).toBe(401);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);

    await app.close();
  });
});
