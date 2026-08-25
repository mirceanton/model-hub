import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Streams a file's contents through SHA-256 and resolves the hex digest.
 * Used by sync/reconcile.ts to populate files.contentHash, which powers
 * duplicate-model detection (lib/duplicates.ts). Kept as its own module
 * (rather than inlined in reconcile.ts) so tests can spy on it to assert
 * unchanged files aren't rehashed on every scan.
 */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
