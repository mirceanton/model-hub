import { sqliteTable, integer, text, uniqueIndex, primaryKey, index } from "drizzle-orm/sqlite-core";

export const models = sqliteTable("models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fsId: text("fs_id").notNull().unique(),
  path: text("path").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  primaryFilePath: text("primary_file_path"),
  thumbnailPath: text("thumbnail_path"),
  thumbnailStatus: text("thumbnail_status", {
    enum: ["pending", "generating", "ready", "error"],
  })
    .notNull()
    .default("pending"),
  // "manual" (a user-captured shot from the interactive viewer) is sticky: the
  // sync-triggered auto-regeneration path (thumbnails/trigger.ts's
  // maybeEnqueueThumbnail) skips models with this source so a future file
  // upload/restore doesn't silently clobber a deliberately-posed thumbnail.
  // The explicit "regenerate" action resets this back to "auto".
  thumbnailSource: text("thumbnail_source", { enum: ["auto", "manual"] })
    .notNull()
    .default("auto"),
  lastSyncedCommitSha: text("last_synced_commit_sha"),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
  syncStatus: text("sync_status", { enum: ["ok", "error", "missing"] })
    .notNull()
    .default("ok"),
  syncError: text("sync_error"),
  missingSince: integer("missing_since", { mode: "timestamp_ms" }),
  // Pins a model to the top of the library list — see api/routes/models.ts's default sort.
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  // Non-null means "in the trash": the on-disk directory has been moved under
  // LIBRARY_ROOT/.trash/ (see lib/fs-utils.ts's TRASH_DIRNAME) and `path`
  // updated to match, and the row is excluded from GET /api/models and every
  // other normal model route by default (see api/routes/models.ts,
  // api/routes/tags.ts's modelCount). The dedicated /api/trash routes
  // (api/routes/trash.ts) are the only ones that operate on these rows —
  // restoring clears this and moves the directory back; a background sweep
  // (sync/scanner.ts's purgeExpiredTrash, riding the same periodic tick as
  // scanLibraryRoot) hard-deletes anything past the retention window.
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const files = sqliteTable(
  "files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    modelId: integer("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    relativePath: text("relative_path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    mtime: integer("mtime", { mode: "timestamp_ms" }).notNull(),
    extension: text("extension").notNull(),
    // SHA-256 hex digest of the file's contents, computed during sync/reconcile
    // (reconcile.ts) and reused across scans as long as mtime/size haven't
    // changed since the last hash — the same invalidation signal this cache
    // already uses for everything else. Null only very briefly (a row whose
    // reconcile hasn't finished hashing it yet isn't observable outside the
    // transaction that inserts it) — never treated as a match against another
    // null. Powers duplicate-model detection (lib/duplicates.ts): two active
    // models sharing any file with the same hash are flagged as possible
    // duplicates of each other.
    contentHash: text("content_hash"),
  },
  (table) => ({
    modelRelativePathUnique: uniqueIndex("files_model_id_relative_path_unique").on(
      table.modelId,
      table.relativePath,
    ),
    contentHashIdx: index("files_content_hash_idx").on(table.contentHash),
  }),
);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Uniqueness is enforced case-insensitively at the application layer (see
  // tags.ts's getOrCreateTag) rather than via a DB collation, since that
  // keeps the lookup portable and simple with Drizzle's standard API.
  name: text("name").notNull().unique(),
  // Hex color (e.g. "#3b82f6"), randomly assigned at creation (see
  // tags.ts's randomTagColor) and editable afterwards. The column default
  // only backfills tags that existed before this feature.
  color: text("color").notNull().default("#6b7280"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const modelTags = sqliteTable(
  "model_tags",
  {
    modelId: integer("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.modelId, table.tagId] }),
    tagIdIdx: index("model_tags_tag_id_idx").on(table.tagId),
  }),
);

/** A user-created grouping that pins several models at specific commits — DB-only, no filesystem/git of its own. */
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * One {model, pinned commit} pair within a project — the "submodule pointer."
 * pinnedCommitMessage is a denormalized snapshot captured at pin/repin time:
 * safe to denormalize because reconcile only ever *appends* commits (no
 * rewrite/rebase in this app), so a given sha's message never changes.
 * modelId cascades on delete: deleting a model (DELETE /api/models/:id,
 * which also removes its directory from disk) silently drops the pin —
 * matches the submodule analogy of the pointed-at repo ceasing to exist.
 * No orphan/placeholder row is kept.
 */
export const projectModelPins = sqliteTable(
  "project_model_pins",
  {
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    modelId: integer("model_id")
      .notNull()
      .references(() => models.id, { onDelete: "cascade" }),
    pinnedCommitSha: text("pinned_commit_sha").notNull(),
    pinnedCommitMessage: text("pinned_commit_message").notNull(),
    pinnedAt: integer("pinned_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.modelId] }),
    modelIdIdx: index("project_model_pins_model_id_idx").on(table.modelId),
  }),
);

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Null for the synthetic single-user-mode "local owner" row.
  oidcSubject: text("oidc_subject").unique(),
  email: text("email"),
  name: text("name"),
  isLocalOwner: integer("is_local_owner", { mode: "boolean" }).notNull().default(false),
  // The local owner (single-user mode) always resolves as "admin" — enforced
  // in code (session.ts's ensureLocalOwner), not by this column default,
  // since the default here is the safe fallback for everyone else. An OIDC
  // user's role is recomputed from their OIDC groups on every login (see
  // lib/roles.ts's resolveRoleFromGroups) rather than being a durable manual
  // assignment, so group membership changes take effect on next sign-in.
  role: text("role", { enum: ["admin", "editor", "viewer"] })
    .notNull()
    .default("viewer"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * One "OIDC group claim value -> app role" rule, configured by an admin (not
 * an env var — see CLAUDE.md's Auth section) so it's editable without a
 * restart. groupName is matched verbatim against the configurable claim
 * named by authSettings.oidcGroupsClaim.
 */
export const oidcGroupRoleMappings = sqliteTable("oidc_group_role_mappings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupName: text("group_name").notNull().unique(),
  role: text("role", { enum: ["admin", "editor", "viewer"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Singleton row (there is always exactly one, created on first use — see
 * lib/auth-settings.ts's ensureAuthSettings, same pattern as session.ts's
 * ensureLocalOwner) holding the instance-wide OIDC role-mapping config.
 */
export const authSettings = sqliteTable("auth_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The ID token claim to read the user's groups from — provider-specific
  // (Authelia/Authentik/Keycloak all name this differently).
  oidcGroupsClaim: text("oidc_groups_claim").notNull().default("groups"),
  // Safe fallback for an authenticated user whose groups match no mapping —
  // never silently falls through to admin.
  defaultRole: text("default_role", { enum: ["admin", "editor", "viewer"] })
    .notNull()
    .default("viewer"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable("sessions", {
  // Opaque random token; this value (not the row id) is what's stored in the session cookie.
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export type ModelRow = typeof models.$inferSelect;
export type NewModelRow = typeof models.$inferInsert;
export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type ProjectModelPinRow = typeof projectModelPins.$inferSelect;
export type NewProjectModelPinRow = typeof projectModelPins.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type OidcGroupRoleMappingRow = typeof oidcGroupRoleMappings.$inferSelect;
export type AuthSettingsRow = typeof authSettings.$inferSelect;
