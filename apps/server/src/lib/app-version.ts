import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

/**
 * Reads this package's own `version` field from apps/server/package.json —
 * the only version source that exists in this repo (no CI-injected build
 * number or git-sha stamp). Resolved relative to this module's own compiled
 * location (not process.cwd(), which isn't guaranteed to be the package
 * root) via `../../package.json`: this file lives one directory under `src`
 * (dev, run directly by tsx) or one directory under `dist` (prod — `tsc -b`
 * mirrors `src`'s layout into `dist`, and `pnpm deploy` copies package.json
 * alongside `dist`), so the same relative path reaches it in both cases.
 * Cached after the first read since the file never changes at runtime.
 */
export function getAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    cachedVersion = parsed.version ?? "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}
