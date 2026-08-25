import { z } from "zod";
import { normalizeGroupName } from "./lib/auth-settings.js";

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
  // Absolute path to the built web SPA (apps/web/dist). When set, this
  // server also serves the SPA (with client-side-routing fallback) at `/`,
  // making it the single process a Docker deployment runs. Left unset in
  // dev, where the Vite dev server serves the SPA instead.
  STATIC_WEB_DIR: z.string().min(1).optional(),
  // OIDC: unset entirely -> single-user mode (no login). If any of these
  // three are set, all three (and SESSION_SECRET) are required.
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_REDIRECT_URL: z.string().url().optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters").optional(),
  // Comma-separated OIDC group names that always resolve to the admin role,
  // enforced fresh at every boot -- see lib/auth-settings.ts's
  // enforceAdminGroupMappings and CLAUDE.md's Auth/Roles section for why
  // this exists (the group-mapping table starts empty, so without this
  // there's no way for anyone to reach the /admin UI that configures it).
  OIDC_ADMIN_GROUPS: z.string().optional(),
  // Rate limiting (apps/server/src/lib/rate-limit.ts). Auth routes are keyed
  // per-IP (unauthenticated by nature); upload/create routes are keyed
  // per-user (see rate-limit.ts for why that's a no-op in single-user mode).
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  UPLOAD_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
}

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
  staticWebDir: string | null;
  /** null means single-user mode: no auth middleware is mounted at all. */
  oidc: OidcConfig | null;
  sessionSecret: string | null;
  /** Parsed, trimmed, non-empty OIDC_ADMIN_GROUPS. Empty array if unset. */
  oidcAdminGroups: string[];
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
  uploadRateLimitMax: number;
  uploadRateLimitWindowMs: number;
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
  const webBaseUrl = parsed.WEB_BASE_URL ?? `http://127.0.0.1:${parsed.PORT}`;

  const oidcFieldsSet = [parsed.OIDC_ISSUER_URL, parsed.OIDC_CLIENT_ID, parsed.OIDC_CLIENT_SECRET];
  const anyOidcFieldSet = oidcFieldsSet.some((v) => v != null);
  const allOidcFieldsSet = oidcFieldsSet.every((v) => v != null);

  if (anyOidcFieldSet && !allOidcFieldsSet) {
    throw new Error(
      "Invalid environment configuration:\n" +
        "  - OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must all be set together, or all left unset for single-user mode",
    );
  }
  if (anyOidcFieldSet && !parsed.SESSION_SECRET) {
    throw new Error(
      "Invalid environment configuration:\n" +
        "  - SESSION_SECRET is required when OIDC_* is configured (at least 32 characters)",
    );
  }

  const oidc: OidcConfig | null = allOidcFieldsSet
    ? {
        issuerUrl: parsed.OIDC_ISSUER_URL!,
        clientId: parsed.OIDC_CLIENT_ID!,
        clientSecret: parsed.OIDC_CLIENT_SECRET!,
        redirectUrl: parsed.OIDC_REDIRECT_URL ?? `${webBaseUrl}/auth/callback`,
      }
    : null;

  let oidcAdminGroups: string[] = [];
  if (parsed.OIDC_ADMIN_GROUPS) {
    try {
      oidcAdminGroups = parsed.OIDC_ADMIN_GROUPS.split(",").map((name) => normalizeGroupName(name));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid environment configuration:\n  - OIDC_ADMIN_GROUPS: ${message}`);
    }
  }

  return {
    libraryRoot: parsed.LIBRARY_ROOT,
    databasePath: parsed.DATABASE_PATH,
    port: parsed.PORT,
    libraryScanIntervalMs: parsed.LIBRARY_SCAN_INTERVAL_MS,
    syncDebounceMs: parsed.SYNC_DEBOUNCE_MS,
    libraryWatchEnabled: parsed.LIBRARY_WATCH_ENABLED,
    libraryWatchUsePolling: parsed.LIBRARY_WATCH_USE_POLLING,
    logLevel: parsed.LOG_LEVEL,
    webBaseUrl,
    thumbnailConcurrency: parsed.THUMBNAIL_CONCURRENCY,
    staticWebDir: parsed.STATIC_WEB_DIR ?? null,
    oidc,
    sessionSecret: parsed.SESSION_SECRET ?? null,
    oidcAdminGroups,
    authRateLimitMax: parsed.AUTH_RATE_LIMIT_MAX,
    authRateLimitWindowMs: parsed.AUTH_RATE_LIMIT_WINDOW_MS,
    uploadRateLimitMax: parsed.UPLOAD_RATE_LIMIT_MAX,
    uploadRateLimitWindowMs: parsed.UPLOAD_RATE_LIMIT_WINDOW_MS,
  };
}
