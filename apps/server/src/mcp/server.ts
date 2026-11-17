import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { getAppVersion } from "../lib/app-version.js";
import { registerMcpTools, type McpRequestContext } from "./tools.js";

/**
 * MCP endpoint (Streamable HTTP, stateless) mounted at /api/mcp.
 *
 * Why stateless: every POST gets a fresh McpServer + transport, responds
 * with plain JSON (enableJsonResponse) and keeps no session state. That
 * makes the endpoint safe behind a load balancer / multiple replicas and
 * trivially proxyable — e.g. LiteLLM's url-mode MCP registration, which
 * just forwards JSON-RPC POSTs. GET (SSE stream) and DELETE (session
 * teardown) are answered 405 by the transport, per the spec's stateless
 * mode.
 *
 * Why the WebStandard transport instead of the SDK's Node one: the Node
 * StreamableHTTPServerTransport wraps @hono/node-server's request listener,
 * which operates on raw Node streams — that neither composes with Fastify's
 * reply lifecycle nor works under app.inject() (light-my-request), the
 * repo's standard test harness. Converting Fastify's already-parsed request
 * into a Web Request and writing the returned Web Response back through
 * reply works identically in tests and production.
 *
 * Auth: /api/mcp lives under /api/*, so auth/guard.ts already requires a
 * valid session cookie or PAT bearer token on OIDC-protected instances
 * before this handler runs (single-user mode stays open, like the rest of
 * the API). The caller's own auth headers are forwarded into every internal
 * app.inject() call, so tool calls re-authenticate as the same user and can
 * never elevate privileges.
 */
export function registerMcpRoutes(app: FastifyInstance, config: Config): void {
  const serverInfo = { name: "model-hub", version: getAppVersion() };

  const methodNotAllowed = async (_request: unknown, reply: import("fastify").FastifyReply) =>
    reply.code(405).send({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "Method not allowed. This is a stateless MCP endpoint: POST JSON-RPC only (no SSE stream, no session teardown).",
      },
    });
  // Answered here rather than by the transport: the SDK's stateless GET
  // handler opens a standalone SSE stream that never ends, which would hang
  // a plain request/response proxy. The spec allows a stateless server to
  // refuse GET/DELETE outright (405).
  app.get("/api/mcp", methodNotAllowed);
  app.delete("/api/mcp", methodNotAllowed);

  app.post("/api/mcp", async (request, reply) => {
    // Stateless: a fresh transport + server per request (the SDK forbids
    // reusing a stateless transport across requests — message id collisions).
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = new McpServer(serverInfo, {
      capabilities: { tools: {} },
      instructions:
        "model-hub manages a library of 3D-printable model files (STL/3MF/OBJ/STEP) with git-backed versioning. " +
        "Use list_models/get_model to discover models and their files (relativePath) and version history (gitLog). " +
        "create_model and upload_files take base64-encoded file contents; download_file/download_model return base64. " +
        "delete_model moves a model to the recoverable trash; purge_trash is permanent — confirm with the user first. " +
        "Tool access follows the calling token's role: viewer reads, editor creates/uploads/edits, admin deletes.",
    });

    const authHeaders: Record<string, string> = {};
    if (typeof request.headers.authorization === "string") {
      authHeaders.authorization = request.headers.authorization;
    }
    if (typeof request.headers.cookie === "string") {
      authHeaders.cookie = request.headers.cookie;
    }
    const ctx: McpRequestContext = { app, config, user: request.user, authHeaders };
    registerMcpTools(server, ctx);

    try {
      await server.connect(transport);

      // Rebuild the request as a Web Request. Fastify already parsed the
      // JSON body; it is handed to the transport via parsedBody (the
      // serialized body below only keeps the Request well-formed).
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      }
      const init: RequestInit = { method: request.method, headers };
      if (request.method === "POST") {
        init.body = JSON.stringify(request.body ?? null);
        headers.set("content-type", "application/json");
      }
      const webRequest = new Request("http://model-hub.local/api/mcp", init);
      const webResponse = await transport.handleRequest(webRequest, { parsedBody: request.body });

      reply.code(webResponse.status);
      webResponse.headers.forEach((value, name) => {
        // Fastify computes these itself from the payload we send below.
        if (name !== "content-length" && name !== "transfer-encoding") reply.header(name, value);
      });
      const text = await webResponse.text();
      // 202 (notifications) and 405 carry no body.
      return text.length > 0 ? reply.send(text) : reply.send();
    } catch (err) {
      request.log.error({ err }, "MCP request handling failed");
      return reply.code(500).send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal server error" },
      });
    } finally {
      // Response is fully generated at this point; tear the per-request
      // server down so nothing lingers (stateless = no long-lived state).
      await server.close().catch(() => {});
    }
  });
}
