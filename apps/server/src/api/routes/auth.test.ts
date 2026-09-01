import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../../auth/constants.js";
import { createSession, getSessionIdToken } from "../../auth/session.js";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { users as usersTable } from "../../db/schema.js";
import { buildTestConfig } from "../../test-support/config.js";
import { buildApp } from "../app.js";

function insertUser(db: DbClient) {
  const now = new Date();
  return db
    .insert(usersTable)
    .values({ role: "editor", createdAt: now, updatedAt: now })
    .returning()
    .get();
}

const OIDC_CONFIG = {
  issuerUrl: "https://idp.example.com",
  clientId: "model-hub",
  clientSecret: "secret",
  redirectUrl: "http://localhost:4000/auth/callback",
};

describe("POST /auth/logout", () => {
  it("clears the local session and falls back to '/' when the session has no id token", async () => {
    const db = createDbClient(":memory:");
    runMigrations(db);
    const app = buildApp(
      db,
      buildTestConfig({ oidc: OIDC_CONFIG, sessionSecret: "a".repeat(32), webBaseUrl: "http://localhost:4000" }),
    );
    await app.ready();

    const user = insertUser(db);
    const session = createSession(db, user.id); // no id token, e.g. a pre-migration session

    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [SESSION_COOKIE_NAME]: app.signCookie(session.id) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ redirectUrl: "/" });
    expect(getSessionIdToken(db, session.id)).toBeNull(); // row gone entirely, not just id-token-null

    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
    expect(cleared?.value).toBe("");

    await app.close();
  });

  it("returns '/' when there is no session cookie at all", async () => {
    const db = createDbClient(":memory:");
    runMigrations(db);
    const app = buildApp(
      db,
      buildTestConfig({ oidc: OIDC_CONFIG, sessionSecret: "a".repeat(32), webBaseUrl: "http://localhost:4000" }),
    );
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/auth/logout" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ redirectUrl: "/" });

    await app.close();
  });
});
