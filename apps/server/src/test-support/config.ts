import type { Config } from "../config.js";

/**
 * A minimal, valid single-user-mode (`oidc: null`) Config for route tests
 * that need to satisfy registerModelRoutes/registerVersionRoutes's `config`
 * parameter but aren't exercising config-driven behavior themselves.
 * Rate-limit-specific tests should build their own Config with tighter
 * max/window values instead of this one.
 */
export function buildTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    libraryRoot: "/tmp/unused",
    databasePath: ":memory:",
    port: 4000,
    libraryScanIntervalMs: 60_000,
    syncDebounceMs: 5_000,
    libraryWatchEnabled: false,
    libraryWatchUsePolling: false,
    logLevel: "fatal",
    webBaseUrl: "http://localhost:4000",
    thumbnailConcurrency: 1,
    staticWebDir: null,
    oidc: null,
    sessionSecret: null,
    authRateLimitMax: 10,
    authRateLimitWindowMs: 60_000,
    uploadRateLimitMax: 30,
    uploadRateLimitWindowMs: 60_000,
    ...overrides,
  };
}
