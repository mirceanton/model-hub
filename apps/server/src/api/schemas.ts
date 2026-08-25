/**
 * Hand-written JSON Schema building blocks for the `schema:` blocks added to
 * routes for issue #70 (OpenAPI spec generation via @fastify/swagger).
 *
 * Plain JSON Schema, not zod: zod is already a dependency (see config.ts)
 * but is only ever used there for env-var parsing, never for route
 * request/response shapes, and no zod-to-json-schema bridge exists in this
 * repo. Introducing one just for this PR would add a second schema-
 * definition style for a handful of routes; Fastify's native JSON Schema
 * support (which @fastify/swagger reads directly, no bridge needed) is the
 * better fit given the existing codebase has no precedent either way.
 *
 * These are deliberately loose (no `additionalProperties: false`) — the
 * goal is documenting real shapes for the OpenAPI spec and validating the
 * request fields that matter, not tightening validation beyond what routes
 * already accept. See CLAUDE.md / issue #70's note: a schema stricter than
 * a route's actual real-world behavior would reject previously-valid
 * requests.
 */

export const errorResponseSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
  required: ["error"],
} as const;

// Only for the two upload routes (POST /api/models, POST /api/models/:id/upload)
// whose 400 responses also carry `skippedFiles` — a plain errorResponseSchema
// here would have fast-json-stringify silently strip that field.
export const errorResponseWithSkippedFilesSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    skippedFiles: { type: "array", items: { type: "string" } },
  },
  required: ["error"],
} as const;

export const tagSchema = {
  type: "object",
  properties: {
    id: { type: "number" },
    name: { type: "string" },
    color: { type: "string" },
  },
  required: ["id", "name", "color"],
} as const;

export const tagWithCountSchema = {
  type: "object",
  properties: {
    id: { type: "number" },
    name: { type: "string" },
    color: { type: "string" },
    modelCount: { type: "number" },
  },
  required: ["id", "name", "color", "modelCount"],
} as const;

export const duplicateModelRefSchema = {
  type: "object",
  properties: {
    modelId: { type: "number" },
    modelTitle: { type: "string" },
  },
  required: ["modelId", "modelTitle"],
} as const;

export const modelSchema = {
  type: "object",
  properties: {
    id: { type: "number" },
    fsId: { type: "string" },
    path: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    primaryFilePath: { type: ["string", "null"] },
    thumbnailPath: { type: ["string", "null"] },
    thumbnailStatus: { type: "string", enum: ["pending", "generating", "ready", "error"] },
    thumbnailSource: { type: "string", enum: ["auto", "manual"] },
    lastSyncedCommitSha: { type: ["string", "null"] },
    lastSyncedAt: { type: ["number", "null"] },
    syncStatus: { type: "string", enum: ["ok", "error", "missing"] },
    syncError: { type: ["string", "null"] },
    missingSince: { type: ["number", "null"] },
    favorite: { type: "boolean" },
    sourceUrl: { type: ["string", "null"] },
    sourceSnapshotStatus: { type: "string", enum: ["none", "pending", "ready", "error"] },
    sourceSnapshotError: { type: ["string", "null"] },
    sourceSnapshotFetchedAt: { type: ["number", "null"] },
    deletedAt: { type: ["number", "null"] },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
    tags: { type: "array", items: tagSchema },
    duplicateModels: { type: "array", items: duplicateModelRefSchema },
  },
  required: [
    "id",
    "fsId",
    "path",
    "title",
    "description",
    "primaryFilePath",
    "thumbnailPath",
    "thumbnailStatus",
    "thumbnailSource",
    "lastSyncedCommitSha",
    "lastSyncedAt",
    "syncStatus",
    "syncError",
    "missingSince",
    "favorite",
    "sourceUrl",
    "sourceSnapshotStatus",
    "sourceSnapshotError",
    "sourceSnapshotFetchedAt",
    "deletedAt",
    "createdAt",
    "updatedAt",
    "tags",
    "duplicateModels",
  ],
} as const;

export const fileEntrySchema = {
  type: "object",
  properties: {
    relativePath: { type: "string" },
    sizeBytes: { type: "number" },
    mtime: { type: "number" },
    extension: { type: "string" },
  },
  required: ["relativePath", "sizeBytes", "mtime", "extension"],
} as const;

export const gitLogEntrySchema = {
  type: "object",
  properties: {
    sha: { type: "string" },
    message: { type: "string" },
    authorName: { type: "string" },
    authorEmail: { type: "string" },
    date: { type: "string" },
  },
  required: ["sha", "message", "authorName", "authorEmail", "date"],
} as const;

export const modelDetailSchema = {
  type: "object",
  properties: {
    ...modelSchema.properties,
    files: { type: "array", items: fileEntrySchema },
    attachments: { type: "array", items: fileEntrySchema },
    gitLog: { type: "array", items: gitLogEntrySchema },
    sourceSnapshotHtml: { type: ["string", "null"] },
  },
  required: [...modelSchema.required, "files", "attachments", "gitLog", "sourceSnapshotHtml"],
} as const;

export const modelListResultSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: modelSchema },
    total: { type: "number" },
  },
  required: ["data", "total"],
} as const;

/** `id` for BulkResult is a number for models.ts, a string (relative path) for versions.ts's per-file bulk delete. */
export function bulkResponseSchema(idType: "number" | "string") {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: idType },
            success: { type: "boolean" },
            error: { type: "string" },
          },
          required: ["id", "success"],
        },
      },
    },
    required: ["results"],
  } as const;
}

export const fileChangeEntrySchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    status: { type: "string", enum: ["added", "modified", "removed"] },
  },
  required: ["path", "status"],
} as const;

export const modelDiffSchema = {
  type: "object",
  properties: {
    commits: { type: "array", items: gitLogEntrySchema },
    files: { type: "array", items: fileChangeEntrySchema },
  },
  required: ["commits", "files"],
} as const;

/**
 * Path param for routes keyed by a numeric-string DB id, e.g.
 * `/api/models/:id`. Deliberately no `pattern` constraint here — routes
 * validate numeric-ness themselves (`Number.isInteger(...)`) and return a
 * specific `{ error: "invalid model id" }` 400; a schema-level pattern would
 * make Fastify reject non-numeric ids itself first, with its own generic
 * validation-error body, silently changing that response shape.
 */
export const numericIdParamSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
  },
  required: ["id"],
} as const;
