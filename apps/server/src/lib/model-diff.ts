import type { GitLogEntry, ModelDiff } from "@model-hub/shared";
import { getFileDiff, getLog } from "../sync/git.js";
import { validateShaInLog } from "./project-pins.js";

/**
 * Commits strictly between `from` and `to` within `log` (newest-first, as
 * returned by getLog), always including whichever of the two is newer and
 * excluding whichever is older — direction-agnostic, so this reads the same
 * whether `to` is newer than `from` (the common pin-bump case) or older (a
 * manual rollback re-pin): either way it's "the commits that differ between
 * the two pins."
 */
function commitsBetween(log: GitLogEntry[], from: string, to: string): GitLogEntry[] {
  const fromIdx = log.findIndex((entry) => entry.sha === from);
  const toIdx = log.findIndex((entry) => entry.sha === to);
  const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
  return log.slice(lo, hi);
}

/**
 * Backs GET /api/models/:id/diff: validates both `from` and `to` against
 * the model's own git log (same sha-validation helper resolvePinTarget
 * uses) before running any git command against them, then returns the
 * intervening commit log plus a `git diff --name-status` file-level change
 * list. Used by the project pin-bump UI to preview a bump (manual re-pin or
 * the "bump to latest" quick action) before committing to it — see issue
 * #68. File-list diff only; a visual/geometric mesh diff is out of scope.
 */
export async function getModelDiff(modelPath: string, from: string, to: string): Promise<ModelDiff> {
  const log = await getLog(modelPath);
  validateShaInLog(log, from);
  validateShaInLog(log, to);

  const commits = commitsBetween(log, from, to);
  const files = await getFileDiff(modelPath, from, to);
  return { commits, files };
}
