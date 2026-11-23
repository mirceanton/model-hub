import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/api-tokens.js";
import { INTERNAL_RENDER_HEADER, INTERNAL_RENDER_TOKEN } from "../auth/internal-token.js";
import { SESSION_COOKIE_NAME } from "../auth/constants.js";
import { createSession } from "../auth/session.js";
import { buildApp } from "../api/app.js";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { users as usersTable, type UserRow } from "../db/schema.js";
import { buildTestConfig } from "../test-support/config.js";
import type { Config } from "../config.js";
import type { FastifyInstance } from "fastify";

/**
 * End-to-end tests for the MCP endpoint (POST /api/mcp, stateless Streamable
 * HTTP). Real buildApp, real route handlers behind app.inject — the same
 * convention as api/app.test.ts. Raw JSON-RPC over app.inject instead of the
 * SDK client: the transport is plain request/response JSON here
 * (enableJsonResponse), so inject exercises exactly what a proxy like
 * LiteLLM's url-mode MCP registration forwards.
 */

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rpc(
  app: FastifyInstance,
  method: string,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
  id: number = 1,
): Promise<{ status: number; body: JsonRpcResponse }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/mcp",
    headers: { ...MCP_HEADERS, ...headers },
    payload: { jsonrpc: "2.0", id, method, params },
  });
  return { status: res.statusCode, body: res.json() as JsonRpcResponse };
}

async function initialize(app: FastifyInstance, headers: Record<string, string> = {}) {
  return rpc(
    app,
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "model-hub-tests", version: "0.0.0" },
    },
    headers,
  );
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

/** Calls a tool and parses its JSON text payload (every model-hub tool returns JSON). */
async function callTool(
  app: FastifyInstance,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; data: Record<string, unknown>; raw: ToolCallResult }> {
  const { status, body } = await rpc(app, "tools/call", { name, arguments: args }, headers);
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();
  const raw = body.result as unknown as ToolCallResult;
  const text = raw.content[0]?.text ?? "";
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON error text — keep data empty, raw still carries the message
  }
  return { ok: !raw.isError, data, raw };
}

const STL_BYTES = "solid bracket\nfacet normal 0 0 1\nendfacet\nendsolid bracket\n";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function insertUser(db: DbClient, role: "viewer" | "editor" | "admin"): UserRow {
  const now = new Date();
  return db.insert(usersTable).values({ role, createdAt: now, updatedAt: now }).returning().get();
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

const EXPECTED_TOOLS = [
  "list_models",
  "get_model",
  "download_file",
  "download_model",
  "list_tags",
  "list_projects",
  "get_project",
  "list_trash",
  "create_model",
  "update_model",
  "upload_files",
  "restore_version",
  "diff_versions",
  "add_model_tag",
  "remove_model_tag",
  "create_project",
  "update_project",
  "pin_model",
  "update_pin",
  "unpin_model",
  "set_pin_printed",
  "sync_library",
  "delete_model",
  "delete_file",
  "restore_trash",
  "purge_trash",
  "delete_project",
].sort();

describe("MCP endpoint — single-user mode", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-mcp-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildApp(db, buildTestConfig({ libraryRoot }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("initialize handshake reports server info and tools capability, without a session id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: MCP_HEADERS,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "model-hub-tests", version: "0.0.0" },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined(); // stateless by design
    const body = res.json();
    expect(body.result.serverInfo.name).toBe("model-hub");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(typeof body.result.instructions).toBe("string");
  });

  it("tools/list exposes the full CRUD surface and works without prior initialize (stateless)", async () => {
    const { status, body } = await rpc(app, "tools/list", {});
    expect(status).toBe(200);
    const tools = (body.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect((tool as { description?: string }).description).toBeTruthy();
      expect((tool as { inputSchema?: unknown }).inputSchema).toBeDefined();
    }
  });

  it("GET and DELETE are 405 (no SSE stream / session teardown in stateless mode)", async () => {
    // No content-type header: GET/DELETE carry no body (a JSON content-type
    // with an empty body would be rejected by Fastify's parser before the
    // route handler — real MCP clients don't send one here either).
    const get = await app.inject({ method: "GET", url: "/api/mcp", headers: { accept: "text/event-stream" } });
    expect(get.statusCode).toBe(405);
    const del = await app.inject({ method: "DELETE", url: "/api/mcp", headers: { accept: "application/json" } });
    expect(del.statusCode).toBe(405);
  });

  it("unknown tool is an error, not a crash", async () => {
    const { status, body } = await rpc(app, "tools/call", { name: "no_such_tool", arguments: {} });
    expect(status).toBe(200);
    // SDK versions differ: JSON-RPC error or an isError tool result.
    const result = body.result as { isError?: boolean } | undefined;
    expect(body.error !== undefined || result?.isError === true).toBe(true);
  });

  it("full model lifecycle: create -> read -> download -> new version -> restore -> tag -> trash -> restore -> purge", async () => {
    // create
    const created = await callTool(app, "create_model", {
      title: "MCP Bracket",
      files: [{ filename: "bracket.stl", contentBase64: b64(STL_BYTES) }],
      tags: ["test-tag"],
      sourceUrl: "https://example.com/bracket",
    });
    expect(created.ok).toBe(true);
    const modelId = created.data.id as number;
    expect(modelId).toBeGreaterThan(0);

    // list + read
    const listed = await callTool(app, "list_models", { q: "bracket" });
    expect(listed.ok).toBe(true);
    expect(listed.data.total).toBe(1);
    const detail = await callTool(app, "get_model", { id: modelId });
    expect(detail.ok).toBe(true);
    expect(detail.data.title).toBe("MCP Bracket");
    const files = detail.data.files as Array<{ relativePath: string }>;
    expect(files.map((f) => f.relativePath)).toContain("bracket.stl");
    const gitLog = detail.data.gitLog as Array<{ sha: string }>;
    expect(gitLog.length).toBe(1);
    const initialSha = gitLog[0]?.sha ?? "";
    expect(initialSha).toMatch(/^[0-9a-f]{7,40}$/);

    // download the file back, byte-for-byte
    const downloaded = await callTool(app, "download_file", { id: modelId, path: "bracket.stl" });
    expect(downloaded.ok).toBe(true);
    expect(downloaded.data.filename).toBe("bracket.stl");
    expect(Buffer.from(downloaded.data.contentBase64 as string, "base64").toString("utf8")).toBe(STL_BYTES);

    // whole-model zip download
    const zip = await callTool(app, "download_model", { id: modelId });
    expect(zip.ok).toBe(true);
    expect((zip.data.sizeBytes as number) ?? 0).toBeGreaterThan(0);
    expect(zip.data.contentBase64).toBeTruthy();

    // upload a new version: modifies bracket.stl AND adds bracket-v2.stl
    const uploaded = await callTool(app, "upload_files", {
      id: modelId,
      files: [
        { filename: "bracket.stl", contentBase64: b64(STL_BYTES.replace("bracket", "bracket-v2")) },
        { filename: "bracket-v2.stl", contentBase64: b64(STL_BYTES.replace("bracket", "bracket-v2")) },
      ],
      message: "second version via MCP",
    });
    expect(uploaded.ok).toBe(true);
    const afterUpload = await callTool(app, "get_model", { id: modelId });
    expect((afterUpload.data.gitLog as unknown[]).length).toBe(2);
    expect((afterUpload.data.files as Array<{ relativePath: string }>).map((f) => f.relativePath).sort()).toEqual([
      "bracket-v2.stl",
      "bracket.stl",
    ]);

    // diff between the two versions shows the added + modified files
    const secondSha = (afterUpload.data.gitLog as Array<{ sha: string }>)[0]?.sha ?? "";
    const diff = await callTool(app, "diff_versions", { id: modelId, from: initialSha, to: secondSha });
    expect(diff.ok).toBe(true);
    expect(diff.data.files).toHaveLength(2);
    expect(diff.data.files).toEqual(
      expect.arrayContaining([
        { path: "bracket-v2.stl", status: "added" },
        { path: "bracket.stl", status: "modified" },
      ]),
    );

    // restore the initial version: tracked file contents roll back and the
    // restoration is committed as a new version (history preserved). Files
    // ADDED since the target commit are kept — restoreToCommit never deletes.
    const restored = await callTool(app, "restore_version", { id: modelId, sha: initialSha });
    expect(restored.ok).toBe(true);
    const afterRestore = await callTool(app, "get_model", { id: modelId });
    expect((afterRestore.data.gitLog as unknown[]).length).toBe(3);
    expect((afterRestore.data.files as Array<{ relativePath: string }>).map((f) => f.relativePath).sort()).toEqual([
      "bracket-v2.stl",
      "bracket.stl",
    ]);
    const restoredFile = await callTool(app, "download_file", { id: modelId, path: "bracket.stl" });
    expect(Buffer.from(restoredFile.data.contentBase64 as string, "base64").toString("utf8")).toBe(STL_BYTES);

    // metadata edit + tags
    const updated = await callTool(app, "update_model", { id: modelId, description: "edited via MCP", favorite: true });
    expect(updated.ok).toBe(true);
    expect(updated.data.description).toBe("edited via MCP");
    const tagged = await callTool(app, "add_model_tag", { id: modelId, name: "another-tag" });
    expect(tagged.ok).toBe(true);
    const tags = await callTool(app, "list_tags", {});
    expect((tags.data as unknown as Array<{ name: string }>).map((t) => t.name).sort()).toEqual([
      "another-tag",
      "test-tag",
    ]);
    const tagId = (tagged.data.id as number) ?? 0;
    const untagged = await callTool(app, "remove_model_tag", { id: modelId, tagId });
    expect(untagged.ok).toBe(true);

    // soft delete -> trash -> restore
    const deleted = await callTool(app, "delete_model", { id: modelId });
    expect(deleted.ok).toBe(true);
    const trash = await callTool(app, "list_trash", {});
    expect((trash.data as unknown as Array<{ id: number }>).map((m) => m.id)).toContain(modelId);
    const restoredFromTrash = await callTool(app, "restore_trash", { id: modelId });
    expect(restoredFromTrash.ok).toBe(true);
    const backAgain = await callTool(app, "get_model", { id: modelId });
    expect(backAgain.ok).toBe(true);

    // delete again, then permanent purge
    await callTool(app, "delete_model", { id: modelId });
    const purged = await callTool(app, "purge_trash", { id: modelId });
    expect(purged.ok).toBe(true);
    const gone = await callTool(app, "get_model", { id: modelId });
    expect(gone.ok).toBe(false);
  });

  it("project lifecycle: create -> pin -> printed -> unpin -> delete", async () => {
    const created = await callTool(app, "create_model", {
      title: "Pinned Model",
      files: [{ filename: "part.stl", contentBase64: b64(STL_BYTES) }],
    });
    const modelId = created.data.id as number;
    const project = await callTool(app, "create_project", { title: "Print Batch", description: "via MCP" });
    expect(project.ok).toBe(true);
    const projectId = project.data.id as number;

    const pinned = await callTool(app, "pin_model", { projectId, modelId });
    expect(pinned.ok).toBe(true);
    const detail = await callTool(app, "get_project", { id: projectId });
    expect(detail.ok).toBe(true);
    const pins = detail.data.pins as Array<{ modelId: number; printed: boolean }>;
    expect(pins.map((p) => p.modelId)).toContain(modelId);

    const printed = await callTool(app, "set_pin_printed", { projectId, modelId, printed: true });
    expect(printed.ok).toBe(true);
    const unpin = await callTool(app, "unpin_model", { projectId, modelId });
    expect(unpin.ok).toBe(true);
    const deletedProject = await callTool(app, "delete_project", { id: projectId });
    expect(deletedProject.ok).toBe(true);
    // the model itself survives project deletion
    const stillThere = await callTool(app, "get_model", { id: modelId });
    expect(stillThere.ok).toBe(true);
  });

  it("delete_file removes a file (new commit) and 404s on an unknown path", async () => {
    const created = await callTool(app, "create_model", {
      title: "Two Files",
      files: [
        { filename: "a.stl", contentBase64: b64(STL_BYTES) },
        { filename: "b.stl", contentBase64: b64(STL_BYTES) },
      ],
    });
    const modelId = created.data.id as number;
    const removed = await callTool(app, "delete_file", { id: modelId, path: "a.stl" });
    expect(removed.ok).toBe(true);
    const detail = await callTool(app, "get_model", { id: modelId });
    expect((detail.data.files as Array<{ relativePath: string }>).map((f) => f.relativePath)).toEqual(["b.stl"]);
    expect((detail.data.gitLog as unknown[]).length).toBe(2); // removal committed
    const again = await callTool(app, "delete_file", { id: modelId, path: "a.stl" });
    expect(again.ok).toBe(false);
  });

  it("rejects oversized files, invalid base64 and path-traversal filenames", async () => {
    const tiny = buildApp(db, buildTestConfig({ libraryRoot, mcpMaxFileBytes: 16 }));
    await tiny.ready();
    try {
      const tooBig = await callTool(tiny, "create_model", {
        title: "Too Big",
        files: [{ filename: "big.stl", contentBase64: b64(STL_BYTES) }],
      });
      expect(tooBig.ok).toBe(false);
      expect(tooBig.raw.content[0]?.text ?? "").toContain("inline limit");

      const badBase64 = await callTool(tiny, "create_model", {
        title: "Bad Base64",
        files: [{ filename: "x.stl", contentBase64: "!!!not-base64!!!" }],
      });
      expect(badBase64.ok).toBe(false);

      const traversal = await callTool(tiny, "create_model", {
        title: "Traversal",
        files: [{ filename: "../evil.stl", contentBase64: b64("x") }],
      });
      expect(traversal.ok).toBe(false);
    } finally {
      await tiny.close();
    }
  });

  it("accepts uploads larger than Fastify's default 1 MiB body limit", async () => {
    // ~2 MiB file -> ~2.7 MiB base64 JSON body; would 413 at the default bodyLimit.
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const created = await callTool(app, "create_model", {
      title: "Big Upload",
      files: [{ filename: "big.stl", contentBase64: big.toString("base64") }],
    });
    expect(created.ok).toBe(true);
    const detail = await callTool(app, "get_model", { id: created.data.id as number });
    const files = detail.data.files as Array<{ relativePath: string; sizeBytes: number }>;
    expect(files.find((f) => f.relativePath === "big.stl")?.sizeBytes).toBe(big.length);
  });

  it("refuses oversized downloads from the index, before reading or zipping", async () => {
    const created = await callTool(app, "create_model", {
      title: "Download Caps",
      files: [{ filename: "part.stl", contentBase64: b64(STL_BYTES) }],
    });
    const modelId = created.data.id as number;
    const tiny = buildApp(db, buildTestConfig({ libraryRoot, mcpMaxFileBytes: 16 }));
    await tiny.ready();
    try {
      const file = await callTool(tiny, "download_file", { id: modelId, path: "part.stl" });
      expect(file.ok).toBe(false);
      expect(file.data.tooLarge).toBe(true);
      expect(file.data.sizeBytes).toBe(Buffer.byteLength(STL_BYTES));
      expect(file.data.apiPath).toBe(`/api/models/${modelId}/files/part.stl`);

      const zip = await callTool(tiny, "download_model", { id: modelId });
      expect(zip.ok).toBe(false);
      expect(zip.data.tooLarge).toBe(true);
      expect(zip.data.apiPath).toBe(`/api/models/${modelId}/download`);
    } finally {
      await tiny.close();
    }

    // download errors use the route's {error} message, like every other tool
    const missing = await callTool(app, "download_file", { id: 999_999, path: "x.stl" });
    expect(missing.ok).toBe(false);
    expect(missing.data.error).toBe("HTTP 404: model not found");
  });

  it("list_models accepts every sort the REST route accepts and returns {data, total}", async () => {
    await callTool(app, "create_model", {
      title: "Sortable",
      files: [{ filename: "s.stl", contentBase64: b64(STL_BYTES) }],
    });
    for (const sort of ["title", "createdAt", "lastSyncedAt"]) {
      const listed = await callTool(app, "list_models", { sort, order: "desc", perPage: 10 });
      expect(listed.ok).toBe(true);
      expect(listed.data.total).toBe(1);
      expect((listed.data.data as unknown[]).length).toBe(1);
    }
  });

  it("rejects abbreviated shas up front; update_pin moves a pin in place and keeps printed", async () => {
    const created = await callTool(app, "create_model", {
      title: "Versioned",
      files: [{ filename: "v.stl", contentBase64: b64(STL_BYTES) }],
    });
    const modelId = created.data.id as number;
    const firstSha = ((await callTool(app, "get_model", { id: modelId })).data.gitLog as Array<{ sha: string }>)[0]
      ?.sha as string;
    expect(firstSha).toMatch(/^[0-9a-f]{40}$/);

    const short = await rpc(app, "tools/call", {
      name: "restore_version",
      arguments: { id: modelId, sha: firstSha.slice(0, 7) },
    });
    const shortResult = short.body.result as unknown as ToolCallResult | undefined;
    // Either a JSON-RPC invalid-params error or an isError tool result — never a 400 from REST.
    expect(short.body.error !== undefined || shortResult?.isError === true).toBe(true);
    expect(JSON.stringify(short.body)).toContain("40-character");

    const project = await callTool(app, "create_project", { title: "Bump Test" });
    const projectId = project.data.id as number;
    expect((await callTool(app, "pin_model", { projectId, modelId })).ok).toBe(true);
    expect((await callTool(app, "set_pin_printed", { projectId, modelId, printed: true })).ok).toBe(true);

    await callTool(app, "upload_files", {
      id: modelId,
      files: [{ filename: "v.stl", contentBase64: b64(STL_BYTES.replace("bracket", "bracket-v2")) }],
    });
    const latestSha = ((await callTool(app, "get_model", { id: modelId })).data.gitLog as Array<{ sha: string }>)[0]
      ?.sha as string;
    expect(latestSha).not.toBe(firstSha);

    const bumped = await callTool(app, "update_pin", { projectId, modelId });
    expect(bumped.ok).toBe(true);
    const pins = (await callTool(app, "get_project", { id: projectId })).data.pins as Array<{
      modelId: number;
      pinnedCommitSha: string;
      printedAt: number | null;
      isOutdated: boolean;
    }>;
    const pin = pins.find((p) => p.modelId === modelId);
    expect(pin?.pinnedCommitSha).toBe(latestSha);
    expect(pin?.isOutdated).toBe(false);
    expect(pin?.printedAt).not.toBeNull();

    const back = await callTool(app, "update_pin", { projectId, modelId, commitSha: firstSha });
    expect(back.ok).toBe(true);
  });

  it("is absent when mcpEnabled=false", async () => {
    const disabled = buildApp(db, buildTestConfig({ libraryRoot, mcpEnabled: false }));
    await disabled.ready();
    try {
      const res = await disabled.inject({
        method: "POST",
        url: "/api/mcp",
        headers: MCP_HEADERS,
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await disabled.close();
    }
  });

  it("download -> edit -> push back: commitSha feeds baseSha, one commit per changeset, stale baseSha is refused", async () => {
    const created = await callTool(app, "create_model", {
      title: "Agent Edit",
      files: [
        { filename: "body.stl", contentBase64: b64(STL_BYTES) },
        { filename: "old-part.stl", contentBase64: b64(STL_BYTES) },
      ],
    });
    const modelId = created.data.id as number;

    const zip = await callTool(app, "download_model", { id: modelId });
    expect(zip.ok).toBe(true);
    const baseSha = zip.data.commitSha as string;
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
    const single = await callTool(app, "download_file", { id: modelId, path: "body.stl" });
    expect(single.data.commitSha).toBe(baseSha);

    const pushed = await callTool(app, "upload_files", {
      id: modelId,
      baseSha,
      files: [{ filename: "body.stl", contentBase64: b64(STL_BYTES.replace("bracket", "body-v2")) }],
      deletePaths: ["old-part.stl"],
      message: "agent: rework body, drop old part",
    });
    expect(pushed.ok).toBe(true);
    expect(pushed.data.deletedFiles).toEqual(["old-part.stl"]);
    const newSha = pushed.data.headSha as string;
    expect(newSha).not.toBe(baseSha);

    const detail = await callTool(app, "get_model", { id: modelId });
    const gitLog = detail.data.gitLog as Array<{ sha: string; message: string }>;
    expect(gitLog).toHaveLength(2);
    expect(gitLog[0]).toMatchObject({ sha: newSha, message: "agent: rework body, drop old part" });
    expect((detail.data.files as Array<{ relativePath: string }>).map((f) => f.relativePath)).toEqual(["body.stl"]);

    // Pushing again from the ORIGINAL base is a conflict, and changes nothing.
    const stale = await callTool(app, "upload_files", {
      id: modelId,
      baseSha,
      files: [{ filename: "body.stl", contentBase64: b64(STL_BYTES) }],
    });
    expect(stale.ok).toBe(false);
    expect(stale.raw.content[0]?.text ?? "").toContain("409");
    const after = await callTool(app, "get_model", { id: modelId });
    expect((after.data.gitLog as unknown[]).length).toBe(2);
  });

  it("upload_files and create_model accept subfolder paths; delete_file paths can be nested too", async () => {
    const created = await callTool(app, "create_model", {
      title: "Nested MCP",
      files: [
        { filename: "body.stl", contentBase64: b64(STL_BYTES) },
        { filename: "parts/arm.stl", contentBase64: b64(STL_BYTES) },
      ],
    });
    expect(created.ok).toBe(true);
    const modelId = created.data.id as number;

    const pushed = await callTool(app, "upload_files", {
      id: modelId,
      files: [{ filename: "parts/left/hand.stl", contentBase64: b64(STL_BYTES) }],
      deletePaths: ["parts/arm.stl"],
    });
    expect(pushed.ok).toBe(true);
    expect(pushed.data.writtenFiles).toEqual(["parts/left/hand.stl"]);

    const detail = await callTool(app, "get_model", { id: modelId });
    const paths = (detail.data.files as Array<{ relativePath: string }>).map((f) => f.relativePath).sort();
    expect(paths).toEqual(["body.stl", "parts/left/hand.stl"]);

    const nested = await callTool(app, "download_file", { id: modelId, path: "parts/left/hand.stl" });
    expect(Buffer.from(nested.data.contentBase64 as string, "base64").toString("utf8")).toBe(STL_BYTES);

    const traversal = await callTool(app, "upload_files", {
      id: modelId,
      files: [{ filename: "../escape.stl", contentBase64: b64(STL_BYTES) }],
    });
    expect(traversal.ok).toBe(false);
    expect(traversal.raw.content[0]?.text ?? "").toContain("relative, '/'-separated path");
  });

  it("upload_files requires at least one file or deletePath", async () => {
    const created = await callTool(app, "create_model", {
      title: "Empty Push",
      files: [{ filename: "m.stl", contentBase64: b64(STL_BYTES) }],
    });
    const res = await callTool(app, "upload_files", { id: created.data.id as number });
    expect(res.ok).toBe(false);
    expect(res.raw.content[0]?.text ?? "").toContain("at least one file or deletePath");
  });
});

describe("MCP endpoint — OIDC mode (PAT auth + RBAC)", () => {
  let libraryRoot: string;
  let db: DbClient;
  let app: FastifyInstance;
  let viewerToken: string;
  let editorToken: string;
  let adminToken: string;

  const oidcConfig: Partial<Config> = {
    oidc: {
      issuerUrl: "https://idp.example.com",
      clientId: "model-hub",
      clientSecret: "secret",
      redirectUrl: "http://localhost:4000/auth/callback",
    },
    sessionSecret: "a".repeat(32),
  };

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-mcp-oidc-"));
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildApp(db, buildTestConfig({ libraryRoot, ...oidcConfig }));
    await app.ready();
    viewerToken = createApiToken(db, insertUser(db, "viewer").id, "viewer-pat").token;
    editorToken = createApiToken(db, insertUser(db, "editor").id, "editor-pat").token;
    adminToken = createApiToken(db, insertUser(db, "admin").id, "admin-pat").token;
  });

  afterEach(async () => {
    await app.close();
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("401s without credentials and with an invalid token", async () => {
    const anon = await initialize(app);
    expect(anon.status).toBe(401);
    const bad = await initialize(app, bearer("mh_pat_invalid"));
    expect(bad.status).toBe(401);
  });

  it("authenticates with a PAT bearer token and re-authenticates internal calls as the same user", async () => {
    const init = await initialize(app, bearer(editorToken));
    expect(init.status).toBe(200);
    // tools/call goes through app.inject with the forwarded bearer header —
    // if the header were dropped, the internal REST call would 401.
    const created = await callTool(app, "create_model", {
      title: "Editor Model",
      files: [{ filename: "m.stl", contentBase64: b64(STL_BYTES) }],
    }, bearer(editorToken));
    expect(created.ok).toBe(true);
    const listed = await callTool(app, "list_models", {}, bearer(editorToken));
    expect(listed.ok).toBe(true);
    expect(listed.data.total).toBe(1);
  });

  it("also accepts a logged-in session cookie", async () => {
    const user = insertUser(db, "viewer");
    const session = createSession(db, user.id);
    const cookie = { cookie: `${SESSION_COOKIE_NAME}=${app.signCookie(session.id)}` };
    const init = await initialize(app, cookie);
    expect(init.status).toBe(200);
    const listed = await callTool(app, "list_models", {}, cookie);
    expect(listed.ok).toBe(true);
  });

  it("viewer can read but not create, upload or delete", async () => {
    const listed = await callTool(app, "list_models", {}, bearer(viewerToken));
    expect(listed.ok).toBe(true);

    const created = await callTool(app, "create_model", {
      title: "Viewer Attempt",
      files: [{ filename: "m.stl", contentBase64: b64(STL_BYTES) }],
    }, bearer(viewerToken));
    expect(created.ok).toBe(false);
    expect(created.raw.content[0]?.text ?? "").toContain("editor");

    // seed a model as admin, then try viewer mutations against it
    const seeded = await callTool(app, "create_model", {
      title: "Seed",
      files: [{ filename: "m.stl", contentBase64: b64(STL_BYTES) }],
    }, bearer(adminToken));
    const modelId = seeded.data.id as number;
    const upload = await callTool(app, "upload_files", {
      id: modelId,
      files: [{ filename: "n.stl", contentBase64: b64(STL_BYTES) }],
    }, bearer(viewerToken));
    expect(upload.ok).toBe(false);
    const del = await callTool(app, "delete_model", { id: modelId }, bearer(viewerToken));
    expect(del.ok).toBe(false);
    expect(del.raw.content[0]?.text ?? "").toContain("admin");
    // nothing actually changed
    const still = await callTool(app, "get_model", { id: modelId }, bearer(viewerToken));
    expect(still.ok).toBe(true);
  });

  it("editor can create/upload but not delete; admin can delete", async () => {
    const created = await callTool(app, "create_model", {
      title: "Editor CRUD",
      files: [{ filename: "m.stl", contentBase64: b64(STL_BYTES) }],
    }, bearer(editorToken));
    expect(created.ok).toBe(true);
    const modelId = created.data.id as number;

    const del = await callTool(app, "delete_model", { id: modelId }, bearer(editorToken));
    expect(del.ok).toBe(false);
    expect(del.raw.content[0]?.text ?? "").toContain("admin");

    const adminDel = await callTool(app, "delete_model", { id: modelId }, bearer(adminToken));
    expect(adminDel.ok).toBe(true);
  });

  it("upload_files with deletePaths needs admin; plain uploads stay editor-level", async () => {
    const created = await callTool(app, "create_model", {
      title: "Changeset RBAC",
      files: [
        { filename: "a.stl", contentBase64: b64(STL_BYTES) },
        { filename: "b.stl", contentBase64: b64(STL_BYTES) },
      ],
    }, bearer(editorToken));
    const modelId = created.data.id as number;

    const editorDelete = await callTool(app, "upload_files", {
      id: modelId,
      files: [{ filename: "c.stl", contentBase64: b64(STL_BYTES) }],
      deletePaths: ["b.stl"],
    }, bearer(editorToken));
    expect(editorDelete.ok).toBe(false);
    expect(editorDelete.raw.content[0]?.text ?? "").toContain("admin");

    const editorUpload = await callTool(app, "upload_files", {
      id: modelId,
      files: [{ filename: "c.stl", contentBase64: b64(STL_BYTES) }],
    }, bearer(editorToken));
    expect(editorUpload.ok).toBe(true);

    const adminDelete = await callTool(app, "upload_files", {
      id: modelId,
      deletePaths: ["b.stl"],
    }, bearer(adminToken));
    expect(adminDelete.ok).toBe(true);
  });

  it("fails closed when the request resolved no user (internal render token)", async () => {
    // The render token gets past the guard without setting request.user;
    // tool role checks must refuse rather than skip.
    const res = await callTool(app, "list_trash", {}, { [INTERNAL_RENDER_HEADER]: INTERNAL_RENDER_TOKEN });
    expect(res.ok).toBe(false);
    expect(res.raw.content[0]?.text ?? "").toContain("authenticated user");
  });

  it("a token whose user was deleted stops working", async () => {
    const user = insertUser(db, "editor");
    const token = createApiToken(db, user.id, "doomed").token;
    const okBefore = await initialize(app, bearer(token));
    expect(okBefore.status).toBe(200);
    db.delete(usersTable).where(eq(usersTable.id, user.id)).run();
    const after = await initialize(app, bearer(token));
    expect(after.status).toBe(401);
  });
});
