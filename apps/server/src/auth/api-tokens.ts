import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import {
  personalAccessTokens as tokensTable,
  users as usersTable,
  type PersonalAccessTokenRow,
  type UserRow,
} from "../db/schema.js";

export class InvalidTokenLabelError extends Error {}

const MAX_LABEL_LENGTH = 200;
// Prefixed (GitHub/Stripe-style) so a leaked token is greppable in logs/CI
// config, and self-identifying if a user pastes it somewhere by mistake.
const TOKEN_PREFIX = "mh_pat_";
const TOKEN_SECRET_BYTES = 32;

/**
 * SHA-256 hash of the token secret, same primitive lib/hash.ts already uses
 * for file content hashing — not inventing a new crypto approach per the
 * issue. A plain hash-then-lookup (no timing-safe compare) is the right
 * trust model here: what stands between an attacker and the secret is the
 * hash's preimage resistance plus the token's own 256 bits of entropy, not
 * the comparison step, so this mirrors session.ts's getUserBySession
 * (opaque-value lookup, no constant-time compare) rather than a raw-secret
 * comparison that would need one.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeLabel(rawLabel: string): string {
  const trimmed = rawLabel.trim();
  if (!trimmed) {
    throw new InvalidTokenLabelError("label cannot be empty");
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidTokenLabelError(`label cannot exceed ${MAX_LABEL_LENGTH} characters`);
  }
  return trimmed;
}

export interface CreatedApiToken {
  id: number;
  /** Plaintext secret — only ever available here, at creation. Never stored, never logged, never retrievable again. */
  token: string;
  label: string;
  createdAt: Date;
  expiresAt: Date | null;
}

/** Creates a new personal API token for `userId`. Throws InvalidTokenLabelError for an empty/oversized label. */
export function createApiToken(
  db: DbClient,
  userId: number,
  rawLabel: string,
  expiresAt: Date | null = null,
): CreatedApiToken {
  const label = normalizeLabel(rawLabel);
  const secret = randomBytes(TOKEN_SECRET_BYTES).toString("hex");
  const token = `${TOKEN_PREFIX}${secret}`;
  const tokenHash = hashToken(token);
  const now = new Date();

  const row = db
    .insert(tokensTable)
    .values({ userId, tokenHash, label, createdAt: now, expiresAt })
    .returning()
    .get();

  return { id: row.id, token, label: row.label, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

/**
 * Resolves a bearer token to its owning user — the guard.ts counterpart of
 * session.ts's getUserBySession. Returns null for an unknown, revoked, or
 * expired token. On success, best-effort records lastUsedAt (not awaited by
 * the caller's request path; a lost update under concurrent requests just
 * means a slightly stale "last used" timestamp, never a correctness issue).
 */
export function getUserByApiToken(db: DbClient, token: string): UserRow | null {
  const tokenHash = hashToken(token);

  const row = db
    .select({ user: usersTable, tokenRow: tokensTable })
    .from(tokensTable)
    .innerJoin(usersTable, eq(tokensTable.userId, usersTable.id))
    .where(eq(tokensTable.tokenHash, tokenHash))
    .get();

  if (!row) return null;

  const { tokenRow, user } = row;
  if (tokenRow.expiresAt && tokenRow.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  db.update(tokensTable).set({ lastUsedAt: new Date() }).where(eq(tokensTable.id, tokenRow.id)).run();

  return user;
}

/**
 * Newest first — matches trash.ts's desc(deletedAt) listing convention.
 * desc(id) is a tiebreaker for tokens created within the same millisecond
 * (createdAt has ms resolution), so ordering stays deterministic.
 */
export function listApiTokens(db: DbClient, userId: number): PersonalAccessTokenRow[] {
  return db
    .select()
    .from(tokensTable)
    .where(eq(tokensTable.userId, userId))
    .orderBy(desc(tokensTable.createdAt), desc(tokensTable.id))
    .all();
}

/**
 * Deletes a token, scoped to `userId` so a user can only ever revoke their
 * own tokens (even an admin can't revoke another user's via this path —
 * there's no cross-user token management in scope for this feature).
 * Returns false if no matching token was found.
 */
export function revokeApiToken(db: DbClient, userId: number, tokenId: number): boolean {
  const result = db
    .delete(tokensTable)
    .where(and(eq(tokensTable.id, tokenId), eq(tokensTable.userId, userId)))
    .run();
  return result.changes > 0;
}
