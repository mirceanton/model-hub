import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import { registerProjectThumbnailRoutes } from "./project-thumbnails.js";
import { registerProjectRoutes } from "./projects.js";

function buildTestApp(db: DbClient): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(multipart);
  registerProjectRoutes(app, db);
  registerProjectThumbnailRoutes(app, db);
  return app;
}

function buildMultipartBody(fieldName: string, filename: string, contentType: string, data: Buffer): { body: Buffer; boundary: string } {
  const boundary = "----model-hub-test-boundary";
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return { body: Buffer.concat(parts), boundary };
}

describe("project thumbnail routes", () => {
  let db: DbClient;
  let app: FastifyInstance;

  beforeEach(() => {
    db = createDbClient(":memory:");
    runMigrations(db);
    app = buildTestApp(db);
  });

  afterEach(async () => {
    await app.close();
  });

  it("has no custom thumbnail (and reports so on the project) until one is uploaded, then serves and clears it", async () => {
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Thumb Project" },
    });
    const project = projectRes.json() as { id: number; hasCustomThumbnail: boolean };
    expect(project.hasCustomThumbnail).toBe(false);

    const missingRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}/thumbnail` });
    expect(missingRes.statusCode).toBe(404);

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { body, boundary } = buildMultipartBody("thumbnail", "thumb.png", "image/png", pngBytes);

    const uploadRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/thumbnail`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}/thumbnail` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.headers["content-type"]).toBe("image/png");
    expect(getRes.rawPayload.equals(pngBytes)).toBe(true);

    const detailRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}` });
    expect((detailRes.json() as { hasCustomThumbnail: boolean }).hasCustomThumbnail).toBe(true);

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}/thumbnail` });
    expect(deleteRes.statusCode).toBe(204);

    const afterDeleteRes = await app.inject({ method: "GET", url: `/api/projects/${project.id}/thumbnail` });
    expect(afterDeleteRes.statusCode).toBe(404);

    const afterDeleteDetail = await app.inject({ method: "GET", url: `/api/projects/${project.id}` });
    expect((afterDeleteDetail.json() as { hasCustomThumbnail: boolean }).hasCustomThumbnail).toBe(false);
  });

  it("rejects a non-image upload", async () => {
    const projectRes = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { title: "Reject Project" },
    });
    const project = projectRes.json() as { id: number };

    const { body, boundary } = buildMultipartBody(
      "thumbnail",
      "notes.txt",
      "text/plain",
      Buffer.from("not an image"),
    );
    const uploadRes = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/thumbnail`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(uploadRes.statusCode).toBe(400);
  });
});
