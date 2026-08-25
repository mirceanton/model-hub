import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { personalAccessTokens as tokensTable, users as usersTable, type UserRow } from "../db/schema.js";
import {
  createApiToken,
  getUserByApiToken,
  InvalidTokenLabelError,
  listApiTokens,
  revokeApiToken,
} from "./api-tokens.js";

function insertUser(db: DbClient, overrides: Partial<typeof usersTable.$inferInsert> = {}): UserRow {
  const now = new Date();
  return db
    .insert(usersTable)
    .values({ role: "editor", createdAt: now, updatedAt: now, ...overrides })
    .returning()
    .get();
}

describe("api-tokens", () => {
  let db: DbClient;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);
  });

  describe("createApiToken", () => {
    it("returns a plaintext token and never stores it as-is", () => {
      const user = insertUser(db);
      const created = createApiToken(db, user.id, "slicer hook");

      expect(created.token).toMatch(/^mh_pat_[0-9a-f]{64}$/);
      expect(created.label).toBe("slicer hook");
      expect(created.expiresAt).toBeNull();

      const row = db.select().from(tokensTable).where(eq(tokensTable.id, created.id)).get()!;
      expect(row.tokenHash).not.toBe(created.token);
      expect(row.tokenHash).not.toContain(created.token);
      // SHA-256 hex digest.
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("trims the label and rejects an empty one", () => {
      const user = insertUser(db);
      const created = createApiToken(db, user.id, "  ci  ");
      expect(created.label).toBe("ci");

      expect(() => createApiToken(db, user.id, "")).toThrow(InvalidTokenLabelError);
      expect(() => createApiToken(db, user.id, "   ")).toThrow(InvalidTokenLabelError);
    });

    it("rejects a label over 200 characters", () => {
      const user = insertUser(db);
      expect(() => createApiToken(db, user.id, "a".repeat(201))).toThrow(InvalidTokenLabelError);
    });

    it("accepts an optional expiry", () => {
      const user = insertUser(db);
      const expiresAt = new Date(Date.now() + 60_000);
      const created = createApiToken(db, user.id, "temp", expiresAt);
      expect(created.expiresAt?.getTime()).toBe(expiresAt.getTime());
    });
  });

  describe("getUserByApiToken", () => {
    it("resolves the owning user for a valid token", () => {
      const user = insertUser(db, { name: "Alice", role: "admin" });
      const created = createApiToken(db, user.id, "ci");

      const resolved = getUserByApiToken(db, created.token);
      expect(resolved?.id).toBe(user.id);
      expect(resolved?.role).toBe("admin");
    });

    it("returns null for an unknown token", () => {
      expect(getUserByApiToken(db, "mh_pat_" + "0".repeat(64))).toBeNull();
    });

    it("returns null for a garbage/malformed token", () => {
      expect(getUserByApiToken(db, "not-a-real-token")).toBeNull();
    });

    it("rejects an expired token", () => {
      const user = insertUser(db);
      vi.useFakeTimers();
      try {
        const created = createApiToken(db, user.id, "temp", new Date(Date.now() + 1000));
        expect(getUserByApiToken(db, created.token)?.id).toBe(user.id);

        vi.advanceTimersByTime(2000);
        expect(getUserByApiToken(db, created.token)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("reflects the user's current role, not a snapshot taken at token creation", () => {
      const user = insertUser(db, { role: "viewer" });
      const created = createApiToken(db, user.id, "ci");

      db.update(usersTable).set({ role: "admin" }).where(eq(usersTable.id, user.id)).run();

      expect(getUserByApiToken(db, created.token)?.role).toBe("admin");
    });

    it("records lastUsedAt on successful auth", () => {
      const user = insertUser(db);
      const created = createApiToken(db, user.id, "ci");

      let row = db.select().from(tokensTable).where(eq(tokensTable.id, created.id)).get()!;
      expect(row.lastUsedAt).toBeNull();

      getUserByApiToken(db, created.token);

      row = db.select().from(tokensTable).where(eq(tokensTable.id, created.id)).get()!;
      expect(row.lastUsedAt).not.toBeNull();
    });

    it("does not resolve a revoked token", () => {
      const user = insertUser(db);
      const created = createApiToken(db, user.id, "ci");
      revokeApiToken(db, user.id, created.id);

      expect(getUserByApiToken(db, created.token)).toBeNull();
    });
  });

  describe("listApiTokens", () => {
    it("only lists the given user's tokens, newest first", () => {
      const alice = insertUser(db);
      const bob = insertUser(db);
      createApiToken(db, alice.id, "first");
      createApiToken(db, alice.id, "second");
      createApiToken(db, bob.id, "bob's token");

      const aliceTokens = listApiTokens(db, alice.id);
      expect(aliceTokens.map((t) => t.label)).toEqual(["second", "first"]);
    });

    it("never includes a resolvable plaintext token", () => {
      const user = insertUser(db);
      createApiToken(db, user.id, "ci");
      const rows = listApiTokens(db, user.id);
      expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("revokeApiToken", () => {
    it("deletes the token and returns true", () => {
      const user = insertUser(db);
      const created = createApiToken(db, user.id, "ci");

      expect(revokeApiToken(db, user.id, created.id)).toBe(true);
      expect(listApiTokens(db, user.id)).toHaveLength(0);
    });

    it("returns false for an unknown token id", () => {
      const user = insertUser(db);
      expect(revokeApiToken(db, user.id, 9999)).toBe(false);
    });

    it("refuses to revoke another user's token", () => {
      const alice = insertUser(db);
      const bob = insertUser(db);
      const created = createApiToken(db, bob.id, "bob's token");

      expect(revokeApiToken(db, alice.id, created.id)).toBe(false);
      expect(listApiTokens(db, bob.id)).toHaveLength(1);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
