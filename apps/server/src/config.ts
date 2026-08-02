import { z } from "zod";

const envSchema = z.object({
  LIBRARY_ROOT: z
    .string()
    .min(1, "LIBRARY_ROOT must be set to the path of your model library"),
  DATABASE_PATH: z
    .string()
    .min(1, "DATABASE_PATH must be set to the path of the SQLite database file"),
  PORT: z.coerce.number().int().positive().default(4000),
  LIBRARY_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SYNC_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(5_000),
  LIBRARY_WATCH_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  LIBRARY_WATCH_USE_POLLING: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  // Base URL the thumbnail renderer navigates Playwright to. Defaults to
  // this server's own origin (correct once it serves the built SPA, per
  // Phase 8); override for dev, where the Vite dev server runs separately.
  WEB_BASE_URL: z.string().url().optional(),
  THUMBNAIL_CONCURRENCY: z.coerce.number().int().positive().default(1),
});

export type Config = {
  libraryRoot: string;
  databasePath: string;
  port: number;
  libraryScanIntervalMs: number;
  syncDebounceMs: number;
  libraryWatchEnabled: boolean;
  libraryWatchUsePolling: boolean;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  webBaseUrl: string;
  thumbnailConcurrency: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const parsed = result.data;
  return {
    libraryRoot: parsed.LIBRARY_ROOT,
    databasePath: parsed.DATABASE_PATH,
    port: parsed.PORT,
    libraryScanIntervalMs: parsed.LIBRARY_SCAN_INTERVAL_MS,
    syncDebounceMs: parsed.SYNC_DEBOUNCE_MS,
    libraryWatchEnabled: parsed.LIBRARY_WATCH_ENABLED,
    libraryWatchUsePolling: parsed.LIBRARY_WATCH_USE_POLLING,
    logLevel: parsed.LOG_LEVEL,
    webBaseUrl: parsed.WEB_BASE_URL ?? `http://127.0.0.1:${parsed.PORT}`,
    thumbnailConcurrency: parsed.THUMBNAIL_CONCURRENCY,
  };
}
