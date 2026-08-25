import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAllAndCommit, catFileBlobStream, initRepo, listFilesAtCommit } from "./git.js";

const IDENTITY = { name: "test", email: "test@example.com" };

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("listFilesAtCommit / catFileBlobStream", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "model-hub-git-test-"));
    await initRepo(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a file's content as it was at an older commit, not the current working tree", async () => {
    await writeFile(join(dir, "part.stl"), "solid v1\nendsolid v1\n", "utf8");
    const v1Sha = await addAllAndCommit(dir, "v1", IDENTITY);

    await writeFile(join(dir, "part.stl"), "solid v2\nendsolid v2\n", "utf8");
    await addAllAndCommit(dir, "v2", IDENTITY);

    const entriesAtV1 = await listFilesAtCommit(dir, v1Sha);
    expect(entriesAtV1.map((e) => e.path)).toEqual(["part.stl"]);

    const content = await streamToBuffer(catFileBlobStream(dir, entriesAtV1[0]!.blobSha));
    expect(content.toString("utf8")).toBe("solid v1\nendsolid v1\n");
  });

  it("lists nested files recursively and reads binary content without corruption", async () => {
    await mkdir(join(dir, "renders"), { recursive: true });
    const binaryContent = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
    await writeFile(join(dir, "renders", "thumb.png"), binaryContent);
    const sha = await addAllAndCommit(dir, "add binary render", IDENTITY);

    const entries = await listFilesAtCommit(dir, sha);
    expect(entries.map((e) => e.path)).toEqual(["renders/thumb.png"]);

    const content = await streamToBuffer(catFileBlobStream(dir, entries[0]!.blobSha));
    expect(content.equals(binaryContent)).toBe(true);
  });
});
