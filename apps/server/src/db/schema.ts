import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type FileRow = typeof files.$inferSelect;
export type NewFileRow = typeof files.$inferInsert;
