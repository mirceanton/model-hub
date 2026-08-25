import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { getAppVersion } from "../lib/app-version.js";

/**
 * Generates the OpenAPI spec from route `schema:` blocks (see the various
 * route files for which ones actually declare real request/response
 * shapes — see issue #70) and serves it at:
 *   - `/docs` — interactive Swagger UI
 *   - `/docs/json` — raw OpenAPI JSON (also `/docs/yaml`, for free, from
 *     @fastify/swagger-ui)
 *
 * Deliberately registered at `/docs`, not under `/api/`: the issue's
 * acceptance criteria name `/docs`/`/docs/json` literally, and those paths
 * don't start with `/api/`, so `auth/guard.ts`'s `isProtectedApiRoute` check
 * wouldn't cover them for free the way it does every route under `/api/`
 * (see health.ts and metrics.ts, which rely on that same exemption to stay
 * deliberately *unauth*'d). Since this route is the opposite case — it must
 * NOT be reachable without a session on an OIDC-protected instance — guard.ts
 * explicitly extends its protected-route check to include `/docs` rather
 * than silently relying on path prefix alone.
 */
export function registerOpenApi(app: FastifyInstance): void {
  app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Model Hub API",
        description: "REST API for the self-hosted model-hub 3D model library.",
        version: getAppVersion(),
      },
      servers: [],
      tags: [
        { name: "models", description: "Model CRUD, listing, and bulk operations" },
        { name: "files", description: "Per-model file upload, download, and deletion" },
        { name: "tags", description: "Tag management" },
      ],
    },
  });

  app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });
}
