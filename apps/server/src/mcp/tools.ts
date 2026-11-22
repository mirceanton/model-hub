import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// The SDK's own shape types: constraining defineTool's generic with anything
// else (e.g. zod's ZodRawShape) leaves registerTool's conditional callback
// type unresolved inside the generic wrapper (TS2345).
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { UserRow } from "../db/schema.js";
import { roleSatisfies } from "../lib/roles.js";
import type { UserRole } from "@model-hub/shared";

/**
 * Everything a tool handler needs to serve one MCP request. `user` is the
 * row auth/guard.ts already resolved for the incoming HTTP request (PAT
 * bearer or session cookie; the synthetic admin local owner in single-user
 * mode). `authHeaders` carries the caller's own authorization/cookie headers
 * so every internal app.inject() call re-authenticates as the SAME user
 * through the same guard — the MCP layer never elevates or bypasses auth.
 */
export interface McpRequestContext {
  app: FastifyInstance;
  config: Config;
  user: UserRow | undefined;
  authHeaders: Record<string, string>;
}

/**
 * The MCP tool surface is a thin protocol adapter over the existing REST
 * API: every tool calls the same route handlers via app.inject(), so MCP
 * and REST stay behaviorally identical by construction (the same convention
 * the bulk routes follow — see models.ts's bulk endpoints). No business
 * logic is duplicated here; this file only translates MCP arguments into
 * HTTP requests and HTTP responses into MCP tool results.
 *
 * One deliberate difference from REST: role enforcement. Several single-
 * item REST routes (DELETE /api/models/:id, DELETE /api/models/:id/files/*)
 * predate the RBAC sweep and are still ungated; the MCP surface enforces
 * the documented role model (CLAUDE.md "Roles") from day one: viewer =
 * read-only, editor = create/upload/edit/tag/pin, admin = delete and trash
 * management. This gates the agent surface only — it is NOT a substitute
 * for gating those REST routes, which remain reachable directly with the
 * same token until the RBAC sweep reaches them.
 */

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string, details?: Record<string, unknown>): CallToolResult {
  const payload = details ? { error: message, ...details } : { error: message };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

// ---------------------------------------------------------------------------
// Internal REST calls (app.inject) — re-authenticated as the calling user
// ---------------------------------------------------------------------------

interface InjectedResponse {
  status: number;
  headers: Record<string, unknown>;
  /** Raw bytes — always safe for binary payloads (file/zip downloads). */
  raw: Buffer;
  /** UTF-8 text form, for JSON responses. */
  text: string;
}

async function injectApi(
  ctx: McpRequestContext,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  opts: { json?: unknown; multipart?: { body: Buffer; contentType: string } } = {},
): Promise<InjectedResponse> {
  const headers: Record<string, string> = { ...ctx.authHeaders };
  let payload: Buffer | object | undefined;
  if (opts.multipart) {
    headers["content-type"] = opts.multipart.contentType;
    payload = opts.multipart.body;
  } else if (opts.json !== undefined) {
    payload = opts.json as object; // light-my-request serializes + sets content-type
  }
  const res = await ctx.app.inject({ method, url, headers, payload });
  return {
    status: res.statusCode,
    headers: res.headers,
    raw: res.rawPayload,
    text: res.payload,
  };
}

/** "HTTP <status>: <message>", using the route's `{error}` field when the body is JSON. */
function httpErrorMessage(res: InjectedResponse): string {
  let message = res.text;
  try {
    const parsed = JSON.parse(res.text) as { error?: string };
    if (parsed.error) message = parsed.error;
  } catch {
    // non-JSON error body — keep the raw text
  }
  return `HTTP ${res.status}: ${message}`;
}

/** Throws with the route's own error message on >=400; parses JSON otherwise (204 -> {ok:true}). */
function unwrapJson(res: InjectedResponse): unknown {
  if (res.status >= 400) throw new Error(httpErrorMessage(res));
  if (res.status === 204 || res.text.length === 0) return { ok: true };
  return JSON.parse(res.text);
}

// ---------------------------------------------------------------------------
// File transfer helpers (base64 in/out, bounded by the mcp* config knobs)
// ---------------------------------------------------------------------------

const uploadedFileSchema = z.object({
  filename: z
    .string()
    .min(1)
    .describe("File name, e.g. 'bracket.stl'. Path separators are rejected; nested paths are not supported."),
  contentBase64: z.string().min(1).describe("The file's bytes, base64-encoded."),
});

interface DecodedFile {
  filename: string;
  bytes: Buffer;
}

function decodeUploadedFiles(
  files: Array<{ filename: string; contentBase64: string }>,
  config: Config,
): DecodedFile[] {
  if (files.length > config.mcpMaxFilesPerCall) {
    throw new Error(`too many files: ${files.length} (max ${config.mcpMaxFilesPerCall} per call)`);
  }
  return files.map((file) => {
    if (/[/\\\0\r\n]/.test(file.filename) || file.filename.length > 255) {
      throw new Error(`invalid filename: ${JSON.stringify(file.filename)}`);
    }
    const normalized = file.contentBase64.replace(/\s+/g, "");
    if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      throw new Error(`contentBase64 for '${file.filename}' is not valid base64`);
    }
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.length === 0) throw new Error(`file '${file.filename}' is empty`);
    if (bytes.length > config.mcpMaxFileBytes) {
      throw new Error(
        `file '${file.filename}' is ${bytes.length} bytes, over the ${config.mcpMaxFileBytes}-byte inline limit. ` +
          `For larger files, drop them into the model's directory on the library share (the watcher picks them up) ` +
          `or use the REST API directly.`,
      );
    }
    return { filename: file.filename, bytes };
  });
}

/** Builds a multipart/form-data body in memory (fields first, then file parts). */
function buildMultipartBody(
  fields: Array<[string, string]>,
  files: DecodedFile[],
): { body: Buffer; contentType: string } {
  const boundary = `----model-hub-mcp-${randomBytes(8).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  for (const file of files) {
    const safeName = file.filename.replace(/["\r\n]/g, "_");
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${safeName}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    chunks.push(file.bytes, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Structured too-large error pointing at the authenticated REST path (the
 * MCP channel is JSON-only — gigabyte models belong on the NFS share or a
 * direct GET).
 */
function tooLargeResult(
  config: Config,
  meta: { filename: string; apiPath: string; sizeBytes: number; uncompressed?: boolean },
): CallToolResult {
  const what = meta.uncompressed ? "bytes uncompressed" : "bytes";
  return errorResult(
    `'${meta.filename}' is ${meta.sizeBytes} ${what}, over the ${config.mcpMaxFileBytes}-byte inline download limit`,
    {
      tooLarge: true,
      sizeBytes: meta.sizeBytes,
      apiPath: meta.apiPath,
      hint: "Fetch it with an authenticated GET (Authorization: Bearer <API token>) or copy it from the library share.",
    },
  );
}

/**
 * Indexed files (model files + attachments) of one model, from the same
 * GET /api/models/:id the get_model tool uses. Lets the download tools
 * check sizes from the DB index BEFORE asking the REST route to read (or
 * zip) anything, so an oversized request never buffers the bytes in memory.
 */
async function getIndexedFiles(
  ctx: McpRequestContext,
  id: number,
): Promise<{ files: Array<{ relativePath: string; sizeBytes: number }>; commitSha: string | null }> {
  const detail = unwrapJson(await injectApi(ctx, "GET", `/api/models/${id}`)) as {
    files?: Array<{ relativePath: string; sizeBytes: number }>;
    attachments?: Array<{ relativePath: string; sizeBytes: number }>;
    lastSyncedCommitSha?: string | null;
  };
  return {
    files: [...(detail.files ?? []), ...(detail.attachments ?? [])],
    commitSha: detail.lastSyncedCommitSha ?? null,
  };
}

/**
 * Shared tail for download_file/download_model: inline the bytes as base64.
 * Callers pre-check the indexed size; the check here is the backstop (e.g.
 * the file grew on disk since it was indexed, or zip overhead).
 */
function inlineDownloadResult(
  res: InjectedResponse,
  config: Config,
  meta: { filename: string; apiPath: string; commitSha: string | null },
): CallToolResult {
  if (res.status >= 400) {
    return errorResult(httpErrorMessage(res));
  }
  if (res.raw.length > config.mcpMaxFileBytes) {
    return tooLargeResult(config, { ...meta, sizeBytes: res.raw.length });
  }
  return jsonResult({
    filename: meta.filename,
    sizeBytes: res.raw.length,
    mimeType: res.headers["content-type"] ?? "application/octet-stream",
    commitSha: meta.commitSha,
    contentBase64: res.raw.toString("base64"),
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

interface ToolMeta<Shape extends ZodRawShapeCompat> {
  description: string;
  inputSchema: Shape;
  minRole: UserRole;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

/**
 * Registers one tool with role enforcement + uniform error handling.
 * The role check mirrors auth/guard.ts's requireRole, including failing
 * CLOSED when no user was resolved (e.g. a request that passed the guard
 * via the internal render token, which carries no user) — no tool runs
 * without an identified caller whose role satisfies minRole.
 */
function defineTool<Shape extends ZodRawShapeCompat>(
  server: McpServer,
  ctx: McpRequestContext,
  name: string,
  meta: ToolMeta<Shape>,
  handler: (args: ShapeOutput<Shape>) => Promise<CallToolResult>,
): void {
  // inputSchema is deliberately widened to ZodRawShapeCompat for the
  // registration call: registerTool's callback type is a conditional type
  // over InputArgs, and passing the generic Shape leaves it unresolved
  // (TS2345 under this repo's TypeScript). With the concrete wide shape the
  // callback args are ShapeOutput<ZodRawShapeCompat> (string-keyed unknowns);
  // the single cast below restores the per-tool typed args. Runtime argument
  // validation is unaffected — the SDK still parses against the real schema.
  const inputSchema: ZodRawShapeCompat = meta.inputSchema;
  server.registerTool(
    name,
    {
      description: meta.description,
      inputSchema,
      annotations: { openWorldHint: false, ...meta.annotations },
    },
    async (args): Promise<CallToolResult> => {
      try {
        if (!ctx.user) {
          return errorResult(`tool '${name}' requires an authenticated user`);
        }
        if (!roleSatisfies(ctx.user.role, meta.minRole)) {
          return errorResult(
            `tool '${name}' requires the '${meta.minRole}' role; this token's user has '${ctx.user.role}'`,
          );
        }
        return await handler((args ?? {}) as unknown as ShapeOutput<Shape>);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// The REST routes match shas exactly against the model's git log (full
// 40-hex shas, as get_model's gitLog returns them) — abbreviated shas would
// always be rejected there, so reject them up front with a clear message.
const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a full 40-character commit sha from get_model's gitLog");

const modelIdSchema = z.coerce.number().int().positive().describe("Model id (from list_models/get_model)");
const projectIdSchema = z.coerce.number().int().positive().describe("Project id (from list_projects/get_project)");

export function registerMcpTools(server: McpServer, ctx: McpRequestContext): void {
  const { config } = ctx;
  const fileLimitNote = `Files transfer as base64, max ${config.mcpMaxFileBytes} bytes each, max ${config.mcpMaxFilesPerCall} files per call.`;

  // ---- Read-only tools (viewer+) ------------------------------------------

  defineTool(
    server,
    ctx,
    "list_models",
    {
      description:
        "Search/list models in the library. Returns { data: models (id, title, tags, file stats, thumbnail status, ...), total } where total counts all matches before pagination. Pagination only applies when perPage is set.",
      inputSchema: {
        q: z.string().optional().describe("Case-insensitive substring match on model titles"),
        tag: z.array(z.string()).optional().describe("Only models carrying ALL of these tag names"),
        favorite: z.boolean().optional().describe("true = only starred models"),
        archived: z.boolean().optional().describe("true = only archived models (default view excludes them)"),
        extension: z.string().optional().describe("Only models with a file of this extension, e.g. 'stl' or '.step'"),
        page: z.coerce.number().int().min(1).optional(),
        perPage: z.coerce.number().int().min(1).max(100).optional(),
        sort: z
          .enum(["title", "createdAt", "lastSyncedAt"])
          .optional()
          .describe("Sort field (default: favorites first, then title)"),
        order: z.enum(["asc", "desc"]).optional(),
      },
      minRole: "viewer",
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.q !== undefined) params.set("q", args.q);
      for (const tag of args.tag ?? []) params.append("tag", tag);
      if (args.favorite !== undefined) params.set("favorite", String(args.favorite));
      if (args.archived !== undefined) params.set("archived", String(args.archived));
      if (args.extension !== undefined) params.set("extension", args.extension);
      if (args.page !== undefined) params.set("page", String(args.page));
      if (args.perPage !== undefined) params.set("perPage", String(args.perPage));
      if (args.sort !== undefined) params.set("sort", args.sort);
      if (args.order !== undefined) params.set("order", args.order);
      const qs = params.toString();
      const res = await injectApi(ctx, "GET", `/api/models${qs ? `?${qs}` : ""}`);
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "get_model",
    {
      description:
        "Full detail for one model: metadata, tags, every file (relativePath, size, sha256), non-model attachments, duplicate groups, and gitLog (version history: sha, message, author, date, changed files).",
      inputSchema: { id: modelIdSchema },
      minRole: "viewer",
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const res = await injectApi(ctx, "GET", `/api/models/${args.id}`);
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "download_file",
    {
      description: `Download one file from a model's current version. Returns filename, sizeBytes, mimeType, commitSha (the version it came from — pass it as upload_files' baseSha when pushing edits back) and contentBase64. ${fileLimitNote} Larger files return a tooLarge error with the REST path instead.`,
      inputSchema: {
        id: modelIdSchema,
        path: z.string().min(1).describe("relativePath from get_model's files list, e.g. 'bracket.stl' or 'parts/arm.stl'"),
      },
      minRole: "viewer",
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      // Same wildcard route as delete_file: GET /api/models/:id/files/*
      const encodedPath = args.path.split("/").map(encodeURIComponent).join("/");
      const apiPath = `/api/models/${args.id}/files/${encodedPath}`;
      const filename = args.path.split("/").pop() ?? args.path;
      const { files, commitSha } = await getIndexedFiles(ctx, args.id);
      const indexed = files.find((f) => f.relativePath === args.path);
      if (indexed && indexed.sizeBytes > config.mcpMaxFileBytes) {
        return tooLargeResult(config, { filename, apiPath, sizeBytes: indexed.sizeBytes });
      }
      const res = await injectApi(ctx, "GET", apiPath);
      return inlineDownloadResult(res, config, { filename, apiPath, commitSha });
    },
  );

  defineTool(
    server,
    ctx,
    "download_model",
    {
      description: `Download a whole model as a zip of its current files (every indexed model file and attachment in the working tree; no git history). Returns filename, sizeBytes, commitSha (the version it came from — pass it as upload_files' baseSha when pushing edits back) and contentBase64. ${fileLimitNote} The limit applies to the model's total uncompressed size; larger models return a tooLarge error with the REST path instead.`,
      inputSchema: { id: modelIdSchema },
      minRole: "viewer",
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const apiPath = `/api/models/${args.id}/download`;
      // Check the indexed (uncompressed) total first: the REST route zips at
      // level 9 and app.inject buffers the whole archive, so an oversized
      // model must be refused before the route is ever called.
      const { files, commitSha } = await getIndexedFiles(ctx, args.id);
      const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
      if (totalBytes > config.mcpMaxFileBytes) {
        return tooLargeResult(config, {
          filename: `model-${args.id}.zip`,
          apiPath,
          sizeBytes: totalBytes,
          uncompressed: true,
        });
      }
      const res = await injectApi(ctx, "GET", apiPath);
      const disposition = String(res.headers["content-disposition"] ?? "");
      const match = /filename="?([^";]+)"?/.exec(disposition);
      return inlineDownloadResult(res, config, {
        filename: match?.[1] ?? `model-${args.id}.zip`,
        apiPath,
        commitSha,
      });
    },
  );

  defineTool(
    server,
    ctx,
    "list_tags",
    {
      description: "Every tag, alphabetically, with id, name, color and the count of active models using it.",
      inputSchema: {},
      minRole: "viewer",
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult(unwrapJson(await injectApi(ctx, "GET", "/api/tags"))),
  );

  defineTool(
    server,
    ctx,
    "list_projects",
    {
      description: "List projects (groups of pinned models, e.g. a print batch). Returns id, title, description, pinCount, previewPins, archivedAt.",
      inputSchema: {
        q: z.string().optional().describe("Case-insensitive substring match on project titles"),
        archived: z.boolean().optional().describe("true = only archived projects (default view excludes them)"),
      },
      minRole: "viewer",
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.q !== undefined) params.set("q", args.q);
      if (args.archived !== undefined) params.set("archived", String(args.archived));
      const qs = params.toString();
      return jsonResult(unwrapJson(await injectApi(ctx, "GET", `/api/projects${qs ? `?${qs}` : ""}`)));
    },
  );

  defineTool(
    server,
    ctx,
    "get_project",
    {
      description: "Full detail for one project: metadata, every pinned model (modelId, modelTitle, pinnedCommitSha, isOutdated, printedAt) and active notices (e.g. upstream model changed since pinning).",
      inputSchema: { id: projectIdSchema },
      minRole: "viewer",
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(unwrapJson(await injectApi(ctx, "GET", `/api/projects/${args.id}`))),
  );

  defineTool(
    server,
    ctx,
    "list_trash",
    {
      description: "List soft-deleted models awaiting restore or permanent purge (id, title, deletedAt).",
      inputSchema: {},
      minRole: "viewer",
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult(unwrapJson(await injectApi(ctx, "GET", "/api/trash"))),
  );

  // ---- Mutating tools (editor+) -------------------------------------------

  defineTool(
    server,
    ctx,
    "create_model",
    {
      description: `Create a new model from uploaded files. The server creates the model directory, initializes its git repo and commits the files as the first version. ${fileLimitNote} Returns the created model (including its id).`,
      inputSchema: {
        title: z.string().min(1).describe("Display title; also seeds the directory name (sanitized server-side)"),
        files: z.array(uploadedFileSchema).min(1).describe("The model's files (STL/3MF/STEP/... — any extension is accepted)"),
        tags: z.array(z.string()).optional().describe("Tag names to attach; created on the fly if new"),
        sourceUrl: z.string().optional().describe("Provenance link, e.g. the Printables/Thingiverse page the model came from"),
      },
      minRole: "editor",
    },
    async (args) => {
      const files = decodeUploadedFiles(args.files, config);
      const fields: Array<[string, string]> = [["title", args.title]];
      if (args.sourceUrl !== undefined) fields.push(["sourceUrl", args.sourceUrl]);
      for (const tag of args.tags ?? []) fields.push(["tags", tag]);
      const res = await injectApi(ctx, "POST", "/api/models", {
        multipart: buildMultipartBody(fields, files),
      });
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "update_model",
    {
      description:
        "Edit model metadata. Renaming the title renames the directory on disk; primaryFilePath picks which file the 3D viewer/thumbnail uses; sourceUrl '' clears provenance. At least one field is required.",
      inputSchema: {
        id: modelIdSchema,
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        favorite: z.boolean().optional(),
        archived: z.boolean().optional(),
        primaryFilePath: z.string().optional().describe("relativePath of an existing model file, or '' to reset to auto-pick"),
        sourceUrl: z.string().optional().describe("http(s) URL, or '' to clear"),
      },
      minRole: "editor",
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const { id, ...body } = args;
      const res = await injectApi(ctx, "PATCH", `/api/models/${id}`, { json: body });
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "upload_files",
    {
      description:
        `Add a NEW VERSION to an existing model as ONE commit: uploads files (added or replaced at the model root) and/or deletes files, then commits the whole changeset to the model's git repo. Existing files not re-uploaded or deleted are kept; history is preserved (see get_model's gitLog, restore_version to roll back). ` +
        `For a download → edit → push-back workflow, pass the commitSha you got from download_model/download_file (or get_model's lastSyncedCommitSha) as baseSha: if the model changed in the meantime the call fails with HTTP 409 and nothing is written, so re-download and reapply instead of clobbering someone else's edit. ` +
        `The result's headSha is the new version, usable as the next call's baseSha. Deleting files requires the admin role. ${fileLimitNote}`,
      inputSchema: {
        id: modelIdSchema,
        files: z.array(uploadedFileSchema).optional().describe("Files to add or replace (may be omitted when only deleting)"),
        deletePaths: z
          .array(z.string().min(1))
          .optional()
          .describe("relativePaths (from get_model's files list) to delete in the same commit. Requires the admin role."),
        baseSha: z
          .string()
          .regex(/^[0-9a-fA-F]{7,40}$/, "must be a 7-40 character hex commit sha")
          .optional()
          .describe("Commit sha your edits are based on; the upload is refused (409) if the model's current version differs"),
        message: z
          .string()
          .optional()
          .describe("Commit message for this version (defaults to 'Uploaded <filenames>; deleted <paths>')"),
      },
      minRole: "editor",
    },
    async (args) => {
      const files = decodeUploadedFiles(args.files ?? [], config);
      const deletePaths = args.deletePaths ?? [];
      if (files.length === 0 && deletePaths.length === 0) {
        throw new Error("at least one file or deletePath is required");
      }
      const fields: Array<[string, string]> = [];
      if (args.message !== undefined) fields.push(["message", args.message]);
      if (args.baseSha !== undefined) fields.push(["baseSha", args.baseSha]);
      for (const path of deletePaths) fields.push(["delete", path]);
      const res = await injectApi(ctx, "POST", `/api/models/${args.id}/upload`, {
        multipart: buildMultipartBody(fields, files),
      });
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "restore_version",
    {
      description:
        "Roll a model back to an earlier version: restores tracked file contents to that commit and commits the restoration as a new version (history is never rewritten). Files added after that commit are kept, not deleted. sha comes from get_model's gitLog.",
      inputSchema: {
        id: modelIdSchema,
        sha: commitShaSchema.describe("Full 40-character commit sha from the model's gitLog (matched exactly)"),
      },
      minRole: "editor",
    },
    async (args) => {
      const res = await injectApi(ctx, "POST", `/api/models/${args.id}/restore`, { json: { sha: args.sha } });
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "diff_versions",
    {
      description:
        "Diff two commits of a model: returns the commits between them and the changed files ({path, status: added|modified|removed}). Shas come from get_model's gitLog.",
      inputSchema: {
        id: modelIdSchema,
        from: commitShaSchema.describe("Older full commit sha"),
        to: commitShaSchema.describe("Newer full commit sha"),
      },
      minRole: "viewer",
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const params = new URLSearchParams({ from: args.from, to: args.to });
      const res = await injectApi(ctx, "GET", `/api/models/${args.id}/diff?${params.toString()}`);
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "add_model_tag",
    {
      description: "Attach a tag to a model by name (case-insensitive; created if it doesn't exist). Returns the tag.",
      inputSchema: { id: modelIdSchema, name: z.string().min(1) },
      minRole: "editor",
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const res = await injectApi(ctx, "POST", `/api/models/${args.id}/tags`, { json: { name: args.name } });
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "remove_model_tag",
    {
      description: "Detach a tag from a model (tagId from get_model's tags list). The tag itself is removed too if no other model uses it.",
      inputSchema: {
        id: modelIdSchema,
        tagId: z.coerce.number().int().positive(),
      },
      minRole: "editor",
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const res = await injectApi(ctx, "DELETE", `/api/models/${args.id}/tags/${args.tagId}`);
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "create_project",
    {
      description: "Create a project (a named group of pinned models, e.g. a print batch or assembly). Returns the created project with its id.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
      },
      minRole: "editor",
    },
    async (args) => {
      const res = await injectApi(ctx, "POST", "/api/projects", { json: args });
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "update_project",
    {
      description: "Edit a project's title/description, or archive/unarchive it. At least one field is required.",
      inputSchema: {
        id: projectIdSchema,
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        archived: z.boolean().optional(),
      },
      minRole: "editor",
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const { id, ...body } = args;
      const res = await injectApi(ctx, "PATCH", `/api/projects/${id}`, { json: body });
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "pin_model",
    {
      description:
        "Pin a model into a project at a specific version. commitSha omitted pins the model's latest commit. A pin references that exact commit: later uploads to the model do not move it (get_project flags it as outdated). To move an existing pin, use update_pin rather than unpinning and re-pinning (which would reset its printed flag).",
      inputSchema: {
        projectId: projectIdSchema,
        modelId: modelIdSchema,
        commitSha: commitShaSchema.optional().describe("Full commit sha from the model's gitLog; omit for latest"),
      },
      minRole: "editor",
    },
    async (args) => {
      const body: { modelId: number; commitSha?: string } = { modelId: args.modelId };
      if (args.commitSha !== undefined) body.commitSha = args.commitSha;
      const res = await injectApi(ctx, "POST", `/api/projects/${args.projectId}/pins`, { json: body });
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "update_pin",
    {
      description:
        "Move an existing pin to a different version of its model, in place (keeps the pin's printed flag). commitSha omitted bumps the pin to the model's latest commit.",
      inputSchema: {
        projectId: projectIdSchema,
        modelId: modelIdSchema,
        commitSha: commitShaSchema.optional().describe("Full commit sha from the model's gitLog; omit to bump to latest"),
      },
      minRole: "editor",
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const body: { commitSha?: string } = {};
      if (args.commitSha !== undefined) body.commitSha = args.commitSha;
      const res = await injectApi(ctx, "PATCH", `/api/projects/${args.projectId}/pins/${args.modelId}`, {
        json: body,
      });
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "unpin_model",
    {
      description: "Remove a model's pin from a project.",
      inputSchema: { projectId: projectIdSchema, modelId: modelIdSchema },
      minRole: "editor",
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const res = await injectApi(ctx, "DELETE", `/api/projects/${args.projectId}/pins/${args.modelId}`);
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "set_pin_printed",
    {
      description: "Mark a pinned model in a project as printed (or unmark it).",
      inputSchema: {
        projectId: projectIdSchema,
        modelId: modelIdSchema,
        printed: z.boolean(),
      },
      minRole: "editor",
      annotations: { idempotentHint: true },
    },
    async (args) => {
      const res = await injectApi(ctx, "PATCH", `/api/projects/${args.projectId}/pins/${args.modelId}/printed`, {
        json: { printed: args.printed },
      });
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "sync_library",
    {
      description:
        "Trigger a full library reconciliation scan in the background (picks up files dropped directly onto the NFS/SMB share, removes vanished models, etc.). Returns immediately; poll list_models/get_model for results.",
      inputSchema: {},
      minRole: "editor",
    },
    async () => jsonResult(unwrapJson(await injectApi(ctx, "POST", "/api/sync"))),
  );

  // ---- Destructive tools (admin) ------------------------------------------

  defineTool(
    server,
    ctx,
    "delete_model",
    {
      description:
        "Soft-delete a model: moves it to the trash (recoverable via restore_trash until the retention sweep or purge_trash removes it permanently). Project pins referencing it are dropped with a notice.",
      inputSchema: { id: modelIdSchema },
      minRole: "admin",
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const res = await injectApi(ctx, "DELETE", `/api/models/${args.id}`);
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "delete_file",
    {
      description:
        "Delete one file from a model's working tree and commit the removal as a new version (recoverable via restore_version).",
      inputSchema: {
        id: modelIdSchema,
        path: z.string().min(1).describe("relativePath from get_model's files list"),
      },
      minRole: "admin",
      annotations: { destructiveHint: true },
    },
    async (args) => {
      // The REST route takes the relative path as a URL wildcard
      // (DELETE /api/models/:id/files/*). Encode per segment so nested
      // paths keep their "/" separators while each segment stays safe.
      const encodedPath = args.path.split("/").map(encodeURIComponent).join("/");
      const res = await injectApi(ctx, "DELETE", `/api/models/${args.id}/files/${encodedPath}`);
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "restore_trash",
    {
      description: "Restore a soft-deleted model from the trash back into the library (id from list_trash).",
      inputSchema: { id: modelIdSchema.describe("Trashed model id (from list_trash)") },
      minRole: "admin",
    },
    async (args) => {
      const res = await injectApi(ctx, "POST", `/api/trash/${args.id}/restore`);
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "purge_trash",
    {
      description:
        "PERMANENTLY delete a trashed model: removes its directory, git history and database row. This cannot be undone — confirm with the user before calling.",
      inputSchema: { id: modelIdSchema.describe("Trashed model id (from list_trash)") },
      minRole: "admin",
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const res = await injectApi(ctx, "DELETE", `/api/trash/${args.id}`);
      return jsonResult(unwrapJson(res));
    },
  );

  defineTool(
    server,
    ctx,
    "delete_project",
    {
      description: "Delete a project and all its pins. The pinned models themselves are NOT deleted.",
      inputSchema: { id: projectIdSchema },
      minRole: "admin",
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const res = await injectApi(ctx, "DELETE", `/api/projects/${args.id}`);
      return jsonResult(unwrapJson(res));
    },
  );
}
