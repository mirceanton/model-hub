import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileEntry } from "@model-hub/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureGitignore,
  ensureMarkerId,
  pickPrimaryFile,
  sanitizeModelDirName,
  sanitizeUploadFilename,
} from "./fs-utils.js";

describe("pickPrimaryFile", () => {
  it("returns null when there are no files", () => {
    expect(pickPrimaryFile([])).toBeNull();
  });

  it("prefers .stl over .3mf regardless of size", () => {
    const files: FileEntry[] = [
      { relativePath: "big.3mf", sizeBytes: 10_000, mtime: 0, extension: "3mf" },
      { relativePath: "small.stl", sizeBytes: 10, mtime: 0, extension: "stl" },
    ];
    expect(pickPrimaryFile(files)).toBe("small.stl");
  });

  it("picks the largest file among same-extension candidates", () => {
    const files: FileEntry[] = [
      { relativePath: "part-a.stl", sizeBytes: 100, mtime: 0, extension: "stl" },
      { relativePath: "part-b.stl", sizeBytes: 500, mtime: 0, extension: "stl" },
    ];
    expect(pickPrimaryFile(files)).toBe("part-b.stl");
  });

  it("breaks ties deterministically by path", () => {
    const files: FileEntry[] = [
      { relativePath: "z.stl", sizeBytes: 100, mtime: 0, extension: "stl" },
      { relativePath: "a.stl", sizeBytes: 100, mtime: 0, extension: "stl" },
    ];
    expect(pickPrimaryFile(files)).toBe("a.stl");
  });
});

describe("ensureMarkerId", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "model-hub-marker-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a marker file with a fresh id when none exists", async () => {
    const result = await ensureMarkerId(dir);
    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is idempotent: a second call reuses the same id", async () => {
    const first = await ensureMarkerId(dir);
    const second = await ensureMarkerId(dir);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });
});

describe("ensureGitignore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "model-hub-gitignore-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a .gitignore containing .thumbnails/ and .DS_Store when none exists", async () => {
    const result = await ensureGitignore(dir);
    expect(result.modified).toBe(true);
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    expect(content).toContain(".thumbnails/");
    expect(content).toContain(".DS_Store");
  });

  it("is idempotent once the managed entry is present", async () => {
    await ensureGitignore(dir);
    const second = await ensureGitignore(dir);
    expect(second.modified).toBe(false);
  });

  it("appends to an existing .gitignore without clobbering other entries", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, ".gitignore"), "node_modules/\n", "utf8");
    await ensureGitignore(dir);
    const content = await readFile(join(dir, ".gitignore"), "utf8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".thumbnails/");
  });
});

describe("sanitizeUploadFilename", () => {
  it("accepts a plain model filename", () => {
    expect(sanitizeUploadFilename("part.stl")).toBe("part.stl");
    expect(sanitizeUploadFilename("model.3mf")).toBe("model.3mf");
  });

  it("strips directory components from a path-traversal attempt", () => {
    expect(sanitizeUploadFilename("../../etc/passwd.stl")).toBe("passwd.stl");
    expect(sanitizeUploadFilename("/etc/passwd.stl")).toBe("passwd.stl");
    expect(sanitizeUploadFilename("..\\..\\windows\\evil.stl")).toBe("evil.stl");
  });

  it("rejects non-model extensions", () => {
    expect(sanitizeUploadFilename("readme.txt")).toBeNull();
    expect(sanitizeUploadFilename("archive.zip")).toBeNull();
  });

  it("rejects empty or dot-only names", () => {
    expect(sanitizeUploadFilename("")).toBeNull();
    expect(sanitizeUploadFilename(".")).toBeNull();
    expect(sanitizeUploadFilename("..")).toBeNull();
  });
});

describe("sanitizeModelDirName", () => {
  it("passes through a plain title unchanged", () => {
    expect(sanitizeModelDirName("Benchy")).toBe("Benchy");
  });

  it("collapses internal whitespace", () => {
    expect(sanitizeModelDirName("  a   weird    title  ")).toBe("a weird title");
  });

  it("replaces slashes and other forbidden characters instead of erroring", () => {
    expect(sanitizeModelDirName("Robot/Arm v2?*")).toBe("Robot Arm v2");
    expect(sanitizeModelDirName("a\\b:c\"d<e>f|g")).toBe("a b c d e f g");
  });

  it("strips leading/trailing dots and spaces", () => {
    expect(sanitizeModelDirName("...hidden...")).toBe("hidden");
    expect(sanitizeModelDirName(" . Benchy . ")).toBe("Benchy");
  });

  it("returns null when nothing usable remains", () => {
    expect(sanitizeModelDirName("")).toBeNull();
    expect(sanitizeModelDirName("   ")).toBeNull();
    expect(sanitizeModelDirName("...")).toBeNull();
    expect(sanitizeModelDirName("///")).toBeNull();
  });

  it("truncates very long titles", () => {
    const result = sanitizeModelDirName("x".repeat(200));
    expect(result?.length).toBe(100);
  });
});
