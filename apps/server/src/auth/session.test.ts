import { describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { users as usersTable } from "../db/schema.js";
import { createSession, getSessionIdToken } from "./session.js";

function insertUser(db: DbClient) {
  const now = new Date();
  return db
    .insert(usersTable)
    .values({ role: "editor", createdAt: now, updatedAt: now })
    .returning()
    .get();
}

describe("session id token storage", () => {
  it("stores and retrieves the OIDC id token passed at creation", () => {
    const db = createDbClient(":memory:");
    runMigrations(db);
    const user = insertUser(db);

    const session = createSession(db, user.id, "the-id-token");

    expect(getSessionIdToken(db, session.id)).toBe("the-id-token");
  });

  it("stores null when no id token is given, e.g. single-user-mode sessions", () => {
    const db = createDbClient(":memory:");
    runMigrations(db);
    const user = insertUser(db);

    const session = createSession(db, user.id);

    expect(getSessionIdToken(db, session.id)).toBeNull();
  });

  it("returns null for an unknown session id", () => {
    const db = createDbClient(":memory:");
    runMigrations(db);

    expect(getSessionIdToken(db, "does-not-exist")).toBeNull();
  });
});
