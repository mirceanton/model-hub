import { randomUUID } from "node:crypto";

/**
 * Lets the headless thumbnail worker's Playwright page (thumbnails/generate.ts)
 * fetch model file bytes back through /api/models/:id/files/* without a user
 * session — that page never has one, since it's not a real logged-in browser.
 * Generated fresh per boot, kept only in server memory, never sent to a real
 * client, so a request bearing it could only originate from this same process.
 */
export const INTERNAL_RENDER_TOKEN = randomUUID();
export const INTERNAL_RENDER_HEADER = "x-model-hub-internal-render";
