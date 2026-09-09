import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { authSettings as authSettingsTable, oidcGroupRoleMappings as mappingsTable, users as usersTable } from "../db/schema.js";
import { ensureAuthSettings } from "../lib/auth-settings.js";
import { AccessDeniedError, createSession, getSessionIdToken, upsertOidcUser } from "./session.js";

/** Disables the defaultRole fallback (deny mode) on the singleton auth_settings row. */
function disableDefaultRole(db: DbClient): void {
  const current = ensureAuthSettings(db);
  db.update(authSettingsTable).set({ defaultRole: null }).where(eq(authSettingsTable.id, current.id)).run();
}

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

describe("upsertOidcUser", () => {
  function setup(): DbClient {
    const db = createDbClient(":memory:");
    runMigrations(db);
    return db;
  }

  it("creates a new user at the resolved default role when no group matches", () => {
    const db = setup();

    const user = upsertOidcUser(db, { sub: "sub-1", email: "a@example.com", groups: [] });

    expect(user.role).toBe("viewer"); // ensureAuthSettings's default
    expect(user.oidcSubject).toBe("sub-1");
  });

  it("resolves role from a matching group mapping", () => {
    const db = setup();
    db.insert(mappingsTable)
      .values({ groupName: "admins", role: "admin", createdAt: new Date(), updatedAt: new Date() })
      .run();

    const user = upsertOidcUser(db, { sub: "sub-1", groups: ["admins"] });

    expect(user.role).toBe("admin");
  });

  it("throws AccessDeniedError instead of creating a user when defaultRole is disabled and no group matches", () => {
    const db = setup();
    disableDefaultRole(db);

    expect(() => upsertOidcUser(db, { sub: "sub-1", groups: ["unmapped-group"] })).toThrow(AccessDeniedError);
    expect(db.select().from(usersTable).all()).toHaveLength(0);
  });

  it("still logs a matched-group user in even when defaultRole is disabled", () => {
    const db = setup();
    disableDefaultRole(db);
    db.insert(mappingsTable)
      .values({ groupName: "editors", role: "editor", createdAt: new Date(), updatedAt: new Date() })
      .run();

    const user = upsertOidcUser(db, { sub: "sub-1", groups: ["editors"] });

    expect(user.role).toBe("editor");
  });

  it("denies an existing user whose groups no longer match anything, once defaultRole is disabled", () => {
    const db = setup();
    upsertOidcUser(db, { sub: "sub-1", groups: [] }); // first login, default role applies
    disableDefaultRole(db);

    expect(() => upsertOidcUser(db, { sub: "sub-1", groups: [] })).toThrow(AccessDeniedError);
  });
});
