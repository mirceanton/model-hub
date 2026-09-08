import type { ConfigCategory, ConfigItem, ConfigValueSource } from "@model-hub/shared";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { DbClient } from "../db/client.js";
import { configOverrides as overridesTable } from "../db/schema.js";

export class InvalidConfigKeyError extends Error {}
export class InvalidConfigValueError extends Error {}

type EditableFieldType = "number" | "boolean" | "url";

interface ConfigFieldDef {
  key: string;
  label: string;
  description: string;
  category: ConfigCategory;
  secret: boolean;
  /** Present only for the fields DB-overridable via config-items.ts's set/deleteConfigOverride. */
  editableType?: EditableFieldType;
  effectiveValue: (config: Config) => string | null;
}

/**
 * One entry per env var in config.ts's envSchema, in the same order as
 * .env.example. Only fields with `editableType` accept a DB override — every
 * other field is display-only (see CLAUDE.md's Config viewer notes: either
 * chicken-and-egg impossible, like DATABASE_PATH, or security-sensitive,
 * like the OIDC and session-secret fields).
 */
const FIELDS: ConfigFieldDef[] = [
  {
    key: "LIBRARY_ROOT",
    label: "Library root",
    description: "Absolute path to the directory containing one subfolder per model.",
    category: "library",
    secret: false,
    effectiveValue: (c) => c.libraryRoot,
  },
  {
    key: "DATABASE_PATH",
    label: "Database path",
    description: "Absolute path to the SQLite database file.",
    category: "server",
    secret: false,
    effectiveValue: (c) => c.databasePath,
  },
  {
    key: "PORT",
    label: "Port",
    description: "HTTP port the API listens on.",
    category: "server",
    secret: false,
    effectiveValue: (c) => String(c.port),
  },
  {
    key: "LIBRARY_SCAN_INTERVAL_MS",
    label: "Library scan interval (ms)",
    description: "How often the full-library reconciliation backstop scan runs.",
    category: "library",
    secret: false,
    editableType: "number",
    effectiveValue: (c) => String(c.libraryScanIntervalMs),
  },
  {
    key: "SYNC_DEBOUNCE_MS",
    label: "Sync debounce (ms)",
    description: "Quiet period after a filesystem event before a model is reconciled.",
    category: "library",
    secret: false,
    editableType: "number",
    effectiveValue: (c) => String(c.syncDebounceMs),
  },
  {
    key: "LIBRARY_WATCH_ENABLED",
    label: "Live filesystem watch",
    description: "Whether to run a live chokidar watcher in addition to the periodic scan.",
    category: "library",
    secret: false,
    editableType: "boolean",
    effectiveValue: (c) => String(c.libraryWatchEnabled),
  },
  {
    key: "LIBRARY_WATCH_USE_POLLING",
    label: "Watch via polling",
    description: "Set for network mounts (NFS/SMB) where inotify events are unreliable.",
    category: "library",
    secret: false,
    editableType: "boolean",
    effectiveValue: (c) => String(c.libraryWatchUsePolling),
  },
  {
    key: "LOG_LEVEL",
    label: "Log level",
    description: "pino log level: fatal | error | warn | info | debug | trace.",
    category: "server",
    secret: false,
    effectiveValue: (c) => c.logLevel,
  },
  {
    key: "WEB_BASE_URL",
    label: "Web base URL",
    description: "Base URL the thumbnail renderer navigates a headless browser to.",
    category: "thumbnails",
    secret: false,
    editableType: "url",
    effectiveValue: (c) => c.webBaseUrl,
  },
  {
    key: "THUMBNAIL_CONCURRENCY",
    label: "Thumbnail concurrency",
    description: "How many thumbnails can render concurrently (each is a Chromium page).",
    category: "thumbnails",
    secret: false,
    editableType: "number",
    effectiveValue: (c) => String(c.thumbnailConcurrency),
  },
  {
    key: "STATIC_WEB_DIR",
    label: "Static web dir",
    description: "Absolute path to the built web SPA; when set, this server also serves it.",
    category: "server",
    secret: false,
    effectiveValue: (c) => c.staticWebDir,
  },
  {
    key: "OIDC_ISSUER_URL",
    label: "OIDC issuer URL",
    description: "Your OIDC provider's issuer URL.",
    category: "sso",
    secret: false,
    effectiveValue: (c) => c.oidc?.issuerUrl ?? null,
  },
  {
    key: "OIDC_CLIENT_ID",
    label: "OIDC client ID",
    description: "This app's client ID registered with your OIDC provider.",
    category: "sso",
    secret: false,
    effectiveValue: (c) => c.oidc?.clientId ?? null,
  },
  {
    key: "OIDC_CLIENT_SECRET",
    label: "OIDC client secret",
    description: "This app's client secret registered with your OIDC provider.",
    category: "sso",
    secret: true,
    effectiveValue: (c) => c.oidc?.clientSecret ?? null,
  },
  {
    key: "OIDC_REDIRECT_URL",
    label: "OIDC redirect URL",
    description: "Defaults to `${WEB_BASE_URL}/auth/callback` — override if reverse-proxied differently.",
    category: "sso",
    secret: false,
    effectiveValue: (c) => c.oidc?.redirectUrl ?? null,
  },
  {
    key: "SESSION_SECRET",
    label: "Session secret",
    description: "Signs the session cookie; required (32+ chars) when OIDC is configured.",
    category: "sso",
    secret: true,
    effectiveValue: (c) => c.sessionSecret,
  },
  {
    key: "OIDC_ADMIN_GROUPS",
    label: "OIDC admin groups",
    description: "Comma-separated OIDC group names force-mapped to the admin role on every boot.",
    category: "sso",
    secret: false,
    effectiveValue: (c) => (c.oidcAdminGroups.length > 0 ? c.oidcAdminGroups.join(", ") : null),
  },
  {
    key: "AUTH_RATE_LIMIT_MAX",
    label: "Auth rate limit (requests)",
    description: "Max requests per window to /auth/* routes, keyed per client IP.",
    category: "rate-limiting",
    secret: false,
    editableType: "number",
    effectiveValue: (c) => String(c.authRateLimitMax),
  },
  {
    key: "AUTH_RATE_LIMIT_WINDOW_MS",
    label: "Auth rate limit window (ms)",
    description: "Window over which the auth rate limit above is measured.",
    category: "rate-limiting",
    secret: false,
    editableType: "number",
    effectiveValue: (c) => String(c.authRateLimitWindowMs),
  },
  {
    key: "UPLOAD_RATE_LIMIT_MAX",
    label: "Upload rate limit (requests)",
    description: "Max requests per window to upload/create routes, keyed per authenticated user.",
    category: "rate-limiting",
    secret: false,
    editableType: "number",
    effectiveValue: (c) => String(c.uploadRateLimitMax),
  },
  {
    key: "UPLOAD_RATE_LIMIT_WINDOW_MS",
    label: "Upload rate limit window (ms)",
    description: "Window over which the upload rate limit above is measured.",
    category: "rate-limiting",
    secret: false,
    editableType: "number",
    effectiveValue: (c) => String(c.uploadRateLimitWindowMs),
  },
];

const EDITABLE_FIELDS_BY_KEY = new Map(FIELDS.filter((f) => f.editableType).map((f) => [f.key, f]));

function validateValue(type: EditableFieldType, key: string, trimmed: string): void {
  switch (type) {
    case "number": {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        throw new InvalidConfigValueError(`${key} must be a positive integer`);
      }
      break;
    }
    case "boolean":
      if (trimmed !== "true" && trimmed !== "false") {
        throw new InvalidConfigValueError(`${key} must be "true" or "false"`);
      }
      break;
    case "url":
      try {
        new URL(trimmed);
      } catch {
        throw new InvalidConfigValueError(`${key} must be a valid URL`);
      }
      break;
  }
}

export function getConfigOverrides(db: DbClient): Record<string, string> {
  const rows = db.select().from(overridesTable).all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/** Throws InvalidConfigKeyError if `key` isn't overridable, InvalidConfigValueError if `rawValue` fails that field's type check. */
export function setConfigOverride(db: DbClient, key: string, rawValue: string): void {
  const field = EDITABLE_FIELDS_BY_KEY.get(key);
  if (!field || !field.editableType) {
    throw new InvalidConfigKeyError(`"${key}" is not an overridable config value`);
  }
  const value = rawValue.trim();
  if (!value) {
    throw new InvalidConfigValueError(`${key} cannot be empty`);
  }
  validateValue(field.editableType, key, value);

  const now = new Date();
  db.insert(overridesTable)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: overridesTable.key, set: { value, updatedAt: now } })
    .run();
}

/** Returns false if there was no override for `key`. Throws InvalidConfigKeyError if `key` isn't overridable. */
export function deleteConfigOverride(db: DbClient, key: string): boolean {
  if (!EDITABLE_FIELDS_BY_KEY.has(key)) {
    throw new InvalidConfigKeyError(`"${key}" is not an overridable config value`);
  }
  const result = db.delete(overridesTable).where(eq(overridesTable.key, key)).run();
  return result.changes > 0;
}

/**
 * Builds the full admin Config-viewer list. `env` is only consulted to know
 * whether each var was explicitly set (env always wins over a DB override);
 * every effective value comes from `config` itself, which by this point
 * already has DB overrides merged in (see config.ts's applyConfigOverrides,
 * called once at boot in index.ts).
 */
export function buildConfigItems(
  config: Config,
  env: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): ConfigItem[] {
  return FIELDS.map((field) => {
    const rawEnvValue = env[field.key];
    const envSet = rawEnvValue != null && rawEnvValue !== "";
    const overrideSet = field.editableType != null && overrides[field.key] != null;
    const effective = field.effectiveValue(config);

    let source: ConfigValueSource;
    if (envSet) source = "env";
    else if (overrideSet) source = "override";
    else if (effective != null) source = "default";
    else source = "unset";

    // For "override" this must be the override's own stored value, not
    // `effective` — `config` was merged from overrides once at boot, so its
    // value reflects the *running* process, not a change saved since (which
    // only takes effect after a restart — see config.ts's applyConfigOverrides).
    const rawValue = source === "override" ? (overrides[field.key] ?? null) : effective;
    const value: string | null = source === "unset" ? null : field.secret ? "(set)" : rawValue;

    const item: ConfigItem = {
      key: field.key,
      label: field.label,
      description: field.description,
      category: field.category,
      secret: field.secret,
      editable: field.editableType != null,
      source,
      value,
    };
    return item;
  });
}
