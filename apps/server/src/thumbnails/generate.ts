import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { Page } from "playwright";
import { INTERNAL_RENDER_HEADER, INTERNAL_RENDER_TOKEN } from "../auth/internal-token.js";
import type { DbClient } from "../db/client.js";
import { models as modelsTable, type ModelRow } from "../db/schema.js";
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

type ThumbnailInput = Pick<ModelRow, "id" | "path" | "primaryFilePath">;

function markStatus(db: DbClient, modelId: number, status: "generating" | "ready" | "error"): void {
  db.update(modelsTable).set({ thumbnailStatus: status }).where(eq(modelsTable.id, modelId)).run();
}

/** Renders `model`'s primary file headlessly and writes it to `.thumbnails/thumb.png`. Never throws — failures are recorded via thumbnailStatus. */
export async function generateThumbnail(
  db: DbClient,
  model: ThumbnailInput,
  context: ThumbnailContext,
): Promise<void> {
  const extension = model.primaryFilePath
    ? extname(model.primaryFilePath).slice(1).toLowerCase()
    : "";
  if (!model.primaryFilePath || !MODEL_EXTENSIONS.has(extension)) {
    markStatus(db, model.id, "error");
    return;
  }

  markStatus(db, model.id, "generating");

  let page: Page | undefined;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({
      viewport: VIEWPORT,
      extraHTTPHeaders: { [INTERNAL_RENDER_HEADER]: INTERNAL_RENDER_TOKEN },
    });

    const params = new URLSearchParams({
      modelId: String(model.id),
      file: model.primaryFilePath,
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

    const thumbnailsDir = join(model.path, THUMBNAILS_DIRNAME);
    await mkdir(thumbnailsDir, { recursive: true });
    const thumbnailAbsolutePath = join(thumbnailsDir, THUMBNAIL_FILENAME);
    await page.locator("canvas").screenshot({ path: thumbnailAbsolutePath, omitBackground: true });

    db.update(modelsTable)
      .set({
        thumbnailPath: `${THUMBNAILS_DIRNAME}/${THUMBNAIL_FILENAME}`,
        thumbnailStatus: "ready",
      })
      .where(eq(modelsTable.id, model.id))
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`thumbnail generation failed for model ${model.id}: ${message}`);
    markStatus(db, model.id, "error");
  } finally {
    await page?.close();
  }
}
