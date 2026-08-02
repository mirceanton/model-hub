import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BASE_ENV = {
  LIBRARY_ROOT: "/library",
  DATABASE_PATH: "/data/model-hub.sqlite3",
};

describe("loadConfig", () => {
  it("applies defaults for optional settings", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.port).toBe(4000);
    expect(config.libraryScanIntervalMs).toBe(60_000);
    expect(config.syncDebounceMs).toBe(5_000);
    expect(config.libraryWatchEnabled).toBe(true);
    expect(config.libraryWatchUsePolling).toBe(false);
    expect(config.logLevel).toBe("info");
    expect(config.thumbnailConcurrency).toBe(1);
  });

  it("coerces and honors overrides", () => {
    const config = loadConfig({
      ...BASE_ENV,
      PORT: "5050",
      LIBRARY_WATCH_USE_POLLING: "true",
      LOG_LEVEL: "debug",
      THUMBNAIL_CONCURRENCY: "3",
    });
    expect(config.port).toBe(5050);
    expect(config.libraryWatchUsePolling).toBe(true);
    expect(config.logLevel).toBe("debug");
    expect(config.thumbnailConcurrency).toBe(3);
  });

  it("defaults webBaseUrl to its own origin, derived from PORT", () => {
    const config = loadConfig({ ...BASE_ENV, PORT: "5050" });
    expect(config.webBaseUrl).toBe("http://127.0.0.1:5050");
  });

  it("honors an explicit WEB_BASE_URL override", () => {
    const config = loadConfig({ ...BASE_ENV, WEB_BASE_URL: "http://localhost:5173" });
    expect(config.webBaseUrl).toBe("http://localhost:5173");
  });

  it("fails fast with a clear error when LIBRARY_ROOT is missing", () => {
    expect(() => loadConfig({ DATABASE_PATH: "/data/model-hub.sqlite3" })).toThrow(
      /LIBRARY_ROOT/,
    );
  });

  it("fails fast with a clear error when DATABASE_PATH is missing", () => {
    expect(() => loadConfig({ LIBRARY_ROOT: "/library" })).toThrow(/DATABASE_PATH/);
  });
});
