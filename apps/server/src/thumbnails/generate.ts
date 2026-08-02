import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { Page } from "playwright";
import type { DbClient } from "../db/client.js";
import { projects as projectsTable, type ProjectRow } from "../db/schema.js";
import { MODEL_EXTENSIONS, THUMBNAILS_DIRNAME } from "../lib/fs-utils.js";
import { getBrowser } from "./browser.js";

const RENDER_TIMEOUT_MS = 20_000;
const VIEWPORT = { width: 512, height: 512 };
const THUMBNAIL_FILENAME = "thumb.png";

// Passed as strings (not typed closures) so this Node-only TS project never
// needs DOM lib types just to poll a couple of globals set by the render page.
const READY_OR_ERROR_EXPR =
  "window.__modelHubRenderReady === true || typeof window.__modelHubRenderError === 'string'";
const READ_ERROR_EXPR = "window.__modelHubRenderError";

export interface ThumbnailContext {
  webBaseUrl: string;
}

type ThumbnailInput = Pick<ProjectRow, "id" | "path" | "primaryFilePath">;

function markStatus(db: DbClient, projectId: number, status: "generating" | "ready" | "error"): void {
  db.update(projectsTable).set({ thumbnailStatus: status }).where(eq(projectsTable.id, projectId)).run();
}

/** Renders `project`'s primary file headlessly and writes it to `.thumbnails/thumb.png`. Never throws — failures are recorded via thumbnailStatus. */
export async function generateThumbnail(
  db: DbClient,
  project: ThumbnailInput,
  context: ThumbnailContext,
): Promise<void> {
  const extension = project.primaryFilePath
    ? extname(project.primaryFilePath).slice(1).toLowerCase()
    : "";
  if (!project.primaryFilePath || !MODEL_EXTENSIONS.has(extension)) {
    markStatus(db, project.id, "error");
    return;
  }

  markStatus(db, project.id, "generating");

  let page: Page | undefined;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({ viewport: VIEWPORT });

    const params = new URLSearchParams({
      projectId: String(project.id),
      file: project.primaryFilePath,
      ext: extension,
    });
    await page.goto(`${context.webBaseUrl}/internal/render?${params.toString()}`, {
      waitUntil: "load",
    });

    await page.waitForFunction(READY_OR_ERROR_EXPR, undefined, { timeout: RENDER_TIMEOUT_MS });

    const renderError = await page.evaluate<string | undefined>(READ_ERROR_EXPR);
    if (renderError) {
      throw new Error(renderError);
    }

    const thumbnailsDir = join(project.path, THUMBNAILS_DIRNAME);
    await mkdir(thumbnailsDir, { recursive: true });
    const thumbnailAbsolutePath = join(thumbnailsDir, THUMBNAIL_FILENAME);
    await page.locator("canvas").screenshot({ path: thumbnailAbsolutePath });

    db.update(projectsTable)
      .set({
        thumbnailPath: `${THUMBNAILS_DIRNAME}/${THUMBNAIL_FILENAME}`,
        thumbnailStatus: "ready",
      })
      .where(eq(projectsTable.id, project.id))
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`thumbnail generation failed for project ${project.id}: ${message}`);
    markStatus(db, project.id, "error");
  } finally {
    await page?.close();
  }
}
