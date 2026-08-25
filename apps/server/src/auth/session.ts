import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { sessions as sessionsTable, users as usersTable, type UserRow } from "../db/schema.js";
import { ensureAuthSettings, getGroupRoleMappings } from "../lib/auth-settings.js";
import { resolveRoleFromGroups } from "../lib/roles.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createSession(db: DbClient, userId: number): { id: string; expiresAt: Date } {
  const id = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.insert(sessionsTable).values({ id, userId, createdAt: now, expiresAt }).run();
  return { id, expiresAt };
}

export function getUserBySession(db: DbClient, sessionId: string): UserRow | null {
  const now = new Date();
  const row = db
    .select({ user: usersTable })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(and(eq(sessionsTable.id, sessionId), gt(sessionsTable.expiresAt, now)))
    .get();
  return row?.user ?? null;
}

export function deleteSession(db: DbClient, sessionId: string): void {
  db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId)).run();
}

export interface OidcProfile {
  sub: string;
  email?: string;
  name?: string;
  // Raw values of the configurable groups claim from the ID token (see
  // config.ts's oidcGroupsClaim) — [] when the claim was absent or not an
  // array of strings.
  groups?: string[];
}

/**
 * Resolves an OIDC user's role fresh from their current groups on every
 * login, rather than treating role as a durable manual assignment — a group
 * membership change on the provider side takes effect the next time the
 * user signs in.
 */
function resolveOidcRole(db: DbClient, groups: string[] | undefined) {
  const settings = ensureAuthSettings(db);
  const mappings = getGroupRoleMappings(db);
  return resolveRoleFromGroups(groups ?? [], mappings, settings.defaultRole);
}

export function upsertOidcUser(db: DbClient, profile: OidcProfile): UserRow {
  const existing = db.select().from(usersTable).where(eq(usersTable.oidcSubject, profile.sub)).get();
  const now = new Date();
  const role = resolveOidcRole(db, profile.groups);

  if (existing) {
    const updated = {
      ...existing,
      email: profile.email ?? existing.email,
      name: profile.name ?? existing.name,
      role,
      updatedAt: now,
    };
    db.update(usersTable)
      .set({ email: updated.email, name: updated.name, role, updatedAt: now })
      .where(eq(usersTable.id, existing.id))
      .run();
    return updated;
  }

  return db
    .insert(usersTable)
    .values({
      oidcSubject: profile.sub,
      email: profile.email,
      name: profile.name,
      isLocalOwner: false,
      role,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/**
 * Single-user mode: the one synthetic user every request resolves to.
 * Created on first use, and always kept at "admin" — single-user mode has
 * no login screen and no lesser-privileged concept, unaffected by RBAC.
 */
export function ensureLocalOwner(db: DbClient): UserRow {
  const existing = db.select().from(usersTable).where(eq(usersTable.isLocalOwner, true)).get();
  if (existing) {
    if (existing.role !== "admin") {
      db.update(usersTable).set({ role: "admin" }).where(eq(usersTable.id, existing.id)).run();
      return { ...existing, role: "admin" };
    }
    return existing;
  }

  const now = new Date();
  return db
    .insert(usersTable)
    .values({ isLocalOwner: true, name: "Local Owner", role: "admin", createdAt: now, updatedAt: now })
    .returning()
    .get();
}
