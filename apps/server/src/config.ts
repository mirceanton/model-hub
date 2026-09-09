import type { UserRole } from "@model-hub/shared";
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
  // Every one of these mirrors a value otherwise configured via the /admin
  // UI's SSO tab (auth_settings/oidc_group_role_mappings tables) -- setting
  // it here force-enforces that value fresh on every boot, "env always
  // wins" (see lib/auth-settings.ts's enforceGroupRoleMappings and
  // enforceAuthSettingsFromEnv, and CLAUDE.md's Auth/Roles section).
  OIDC_GROUPS_CLAIM: z.string().min(1).optional(),
  // "deny" disables the fallback entirely: an authenticated user whose
  // groups match no mapping is refused login outright instead of getting
  // any role (see lib/auth-settings.ts's DENY_DEFAULT_ROLE/
  // parseDefaultRoleSetting and auth/session.ts's AccessDeniedError).
  OIDC_DEFAULT_ROLE: z.enum(["admin", "editor", "viewer", "deny"]).optional(),
  // Comma-separated OIDC group names that always resolve to the admin role.
  // Doubles as the bootstrap escape hatch out of the lockout where the
  // group-mapping table starts empty and /admin itself requires the admin
  // role to reach -- without this, nobody could ever configure the first
  // admin mapping.
  OIDC_ADMIN_GROUPS: z.string().optional(),
  // Comma-separated OIDC group names that always resolve to the editor role.
  OIDC_EDITOR_GROUPS: z.string().optional(),
  // Comma-separated OIDC group names that always resolve to the viewer
  // (read-only) role.
  OIDC_READONLY_GROUPS: z.string().optional(),
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
  /** OIDC_GROUPS_CLAIM. Null if unset, in which case the DB-configured (or default "groups") claim name applies. */
  oidcGroupsClaim: string | null;
  /**
   * OIDC_DEFAULT_ROLE. `undefined` if unset (the DB-configured, or default
   * "viewer", value applies); `null` if set to "deny" (unmatched users are
   * refused login); otherwise the forced role.
   */
  oidcDefaultRole: UserRole | null | undefined;
  /** Parsed, trimmed, non-empty OIDC_ADMIN_GROUPS. Empty array if unset. */
  oidcAdminGroups: string[];
  /** Parsed, trimmed, non-empty OIDC_EDITOR_GROUPS. Empty array if unset. */
  oidcEditorGroups: string[];
  /** Parsed, trimmed, non-empty OIDC_READONLY_GROUPS. Empty array if unset. */
  oidcReadonlyGroups: string[];
  authRateLimitMax: number;
  authRateLimitWindowMs: number;
  uploadRateLimitMax: number;
  uploadRateLimitWindowMs: number;
};

/**
 * Merges DB-stored overrides (lib/config-items.ts's EDITABLE_FIELDS_BY_KEY)
 * into a loaded Config, env-wins. Called once at boot (index.ts, right
 * after runMigrations) — see CLAUDE.md's Config viewer notes: every
 * consumer of these fields (scan interval, watcher, thumbnail pipeline,
 * rate limits) reads Config exactly once at startup, so there's no such
 * thing as applying this "live"; a saved override only takes effect on the
 * next restart.
 */
export function applyConfigOverrides(
  config: Config,
  overrides: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Config {
  // Env always wins — an override row can be left stale in the DB after an
  // env var is later set for the same key (see lib/config-items.ts), so
  // it must never apply once that var is present.
  const get = (key: string): string | undefined => (env[key] ? undefined : overrides[key]);
  const num = (key: string, fallback: number): number => {
    const raw = get(key);
    return raw !== undefined ? Number(raw) : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = get(key);
    return raw !== undefined ? raw === "true" : fallback;
  };

  return {
    ...config,
    libraryScanIntervalMs: num("LIBRARY_SCAN_INTERVAL_MS", config.libraryScanIntervalMs),
    syncDebounceMs: num("SYNC_DEBOUNCE_MS", config.syncDebounceMs),
    libraryWatchEnabled: bool("LIBRARY_WATCH_ENABLED", config.libraryWatchEnabled),
    libraryWatchUsePolling: bool("LIBRARY_WATCH_USE_POLLING", config.libraryWatchUsePolling),
    webBaseUrl: get("WEB_BASE_URL") ?? config.webBaseUrl,
    thumbnailConcurrency: num("THUMBNAIL_CONCURRENCY", config.thumbnailConcurrency),
    authRateLimitMax: num("AUTH_RATE_LIMIT_MAX", config.authRateLimitMax),
    authRateLimitWindowMs: num("AUTH_RATE_LIMIT_WINDOW_MS", config.authRateLimitWindowMs),
    uploadRateLimitMax: num("UPLOAD_RATE_LIMIT_MAX", config.uploadRateLimitMax),
    uploadRateLimitWindowMs: num("UPLOAD_RATE_LIMIT_WINDOW_MS", config.uploadRateLimitWindowMs),
  };
}

/** Parses a comma-separated OIDC_*_GROUPS env var into trimmed, validated group names. [] if unset. */
function parseGroupListEnv(raw: string | undefined, varName: string): string[] {
  if (!raw) return [];
  try {
    return raw.split(",").map((name) => normalizeGroupName(name));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid environment configuration:\n  - ${varName}: ${message}`);
  }
}

/**
 * Each of OIDC_ADMIN_GROUPS/OIDC_EDITOR_GROUPS force-maps its groups to a
 * single, different role on every boot (see lib/auth-settings.ts's
 * enforceGroupRoleMappings) -- a group name listed under more than one of
 * these would make boot-time enforcement order-dependent and silently
 * pick a winner, so it's rejected outright instead.
 */
function checkNoGroupInMultipleRoles(groupsByVar: Record<string, string[]>): void {
  const firstVarByGroup = new Map<string, string>();
  for (const [varName, groups] of Object.entries(groupsByVar)) {
    for (const group of groups) {
      const existingVarName = firstVarByGroup.get(group);
      if (existingVarName) {
        throw new Error(
          `Invalid environment configuration:\n  - "${group}" is listed in both ${existingVarName} and ${varName} -- a group can only be force-mapped to one role`,
        );
      }
      firstVarByGroup.set(group, varName);
    }
  }
}

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

  const oidcAdminGroups = parseGroupListEnv(parsed.OIDC_ADMIN_GROUPS, "OIDC_ADMIN_GROUPS");
  const oidcEditorGroups = parseGroupListEnv(parsed.OIDC_EDITOR_GROUPS, "OIDC_EDITOR_GROUPS");
  const oidcReadonlyGroups = parseGroupListEnv(parsed.OIDC_READONLY_GROUPS, "OIDC_READONLY_GROUPS");
  checkNoGroupInMultipleRoles({
    OIDC_ADMIN_GROUPS: oidcAdminGroups,
    OIDC_EDITOR_GROUPS: oidcEditorGroups,
    OIDC_READONLY_GROUPS: oidcReadonlyGroups,
  });

  // "deny" -> null (see the Config.oidcDefaultRole doc comment); leave
  // `undefined` alone so downstream code can tell "unset" apart from
  // "explicitly set to deny".
  const oidcDefaultRole: UserRole | null | undefined =
    parsed.OIDC_DEFAULT_ROLE === undefined
      ? undefined
      : parsed.OIDC_DEFAULT_ROLE === "deny"
        ? null
        : parsed.OIDC_DEFAULT_ROLE;

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
    oidcGroupsClaim: parsed.OIDC_GROUPS_CLAIM ?? null,
    oidcDefaultRole,
    oidcAdminGroups,
    oidcEditorGroups,
    oidcReadonlyGroups,
    authRateLimitMax: parsed.AUTH_RATE_LIMIT_MAX,
    authRateLimitWindowMs: parsed.AUTH_RATE_LIMIT_WINDOW_MS,
    uploadRateLimitMax: parsed.UPLOAD_RATE_LIMIT_MAX,
    uploadRateLimitWindowMs: parsed.UPLOAD_RATE_LIMIT_WINDOW_MS,
  };
}
