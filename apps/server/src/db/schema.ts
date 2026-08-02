import { sqliteTable, integer, text, uniqueIndex, primaryKey, index } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
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
  lastSyncedCommitSha: text("last_synced_commit_sha"),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
  syncStatus: text("sync_status", { enum: ["ok", "error", "missing"] })
    .notNull()
    .default("ok"),
  syncError: text("sync_error"),
  missingSince: integer("missing_since", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const files = sqliteTable(
  "files",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    relativePath: text("relative_path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    mtime: integer("mtime", { mode: "timestamp_ms" }).notNull(),
    extension: text("extension").notNull(),
  },
  (table) => ({
    projectRelativePathUnique: uniqueIndex("files_project_id_relative_path_unique").on(
      table.projectId,
      table.relativePath,
    ),
  }),
);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Uniqueness is enforced case-insensitively at the application layer (see
  // tags.ts's getOrCreateTag) rather than via a DB collation, since that
  // keeps the lookup portable and simple with Drizzle's standard API.
  name: text("name").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const projectTags = sqliteTable(
  "project_tags",
  {
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.tagId] }),
    tagIdIdx: index("project_tags_tag_id_idx").on(table.tagId),
  }),
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
