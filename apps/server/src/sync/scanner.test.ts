import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { models as modelsTable } from "../db/schema.js";
import { TRASH_DIRNAME } from "../lib/fs-utils.js";
import { scanLibraryRoot } from "./scanner.js";

describe("scanLibraryRoot", () => {
  let libraryRoot: string;
  let db: DbClient;

  beforeEach(async () => {
    libraryRoot = await mkdtemp(join(tmpdir(), "model-hub-scanner-"));
    db = createDbClient(":memory:");
    runMigrations(db);
  });

  afterEach(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
  });

  it("ignores .trash/ entirely: doesn't create a model for it and doesn't descend into it", async () => {
    await mkdir(join(libraryRoot, "Benchy"));
    await writeFile(join(libraryRoot, "Benchy", "model.stl"), "solid\nendsolid\n", "utf8");

    const trashDir = join(libraryRoot, TRASH_DIRNAME, "some-fs-id-12345");
    await mkdir(trashDir, { recursive: true });
    await writeFile(join(trashDir, "leftover.stl"), "solid\nendsolid\n", "utf8");

    const result = await scanLibraryRoot(db, libraryRoot);

    expect(result.skipped).toBe(false);
    expect(result.scanned).toBe(1);

    const rows = db.select().from(modelsTable).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Benchy");
    expect(rows.some((r) => r.path.includes(TRASH_DIRNAME))).toBe(false);
  });

  it("never flips a trashed model's status to missing, even though its directory isn't found at its old top-level path", async () => {
    const now = new Date();
    const trashedPath = join(libraryRoot, TRASH_DIRNAME, "fs-id-1-1700000000000");
    await mkdir(trashedPath, { recursive: true });

    db.insert(modelsTable)
      .values({
        fsId: "fs-id-1",
        path: trashedPath,
        title: "Trashed Model",
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await scanLibraryRoot(db, libraryRoot);

    const row = db.select().from(modelsTable).where(eq(modelsTable.fsId, "fs-id-1")).get()!;
    expect(row.syncStatus).toBe("ok"); // untouched default, never marked "missing"
    expect(row.missingSince).toBeNull();
    expect(row.deletedAt).not.toBeNull();
  });
});
