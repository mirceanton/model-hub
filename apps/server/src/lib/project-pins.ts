import type { GitLogEntry, PinnedModel } from "@model-hub/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import {
  models as modelsTable,
  projectModelPins as projectModelPinsTable,
  type ModelRow,
  type ProjectModelPinRow,
} from "../db/schema.js";
import { getLog } from "../sync/git.js";

export class InvalidCommitShaError extends Error {}
export class ModelAlreadyPinnedError extends Error {}
export class ModelHasNoCommitsError extends Error {}

type PinnableModel = Pick<ModelRow, "path" | "lastSyncedCommitSha">;

/**
 * Validates `sha` against an already-fetched git log, throwing
 * InvalidCommitShaError if it isn't a known commit for this model. Shared
 * by resolvePinTarget below and by lib/model-diff.ts's GET
 * /api/models/:id/diff (which validates both its `from` and `to` shas this
 * way before running any git command against them) — same pattern as
 * versions.ts's /restore handler used before this was extracted.
 */
export function validateShaInLog(log: GitLogEntry[], sha: string): GitLogEntry {
  const target = log.find((entry) => entry.sha === sha);
  if (!target) {
    throw new InvalidCommitShaError("sha is not a known commit for this model");
  }
  return target;
}

/**
 * Validates `requestedSha` against the model's own git log — same pattern as
 * versions.ts's /restore handler — or, when omitted, resolves to the model's
 * current lastSyncedCommitSha ("pin to latest right now").
 */
export async function resolvePinTarget(
  model: PinnableModel,
  requestedSha: string | undefined,
): Promise<{ sha: string; message: string }> {
  const sha = requestedSha ?? model.lastSyncedCommitSha;
  if (!sha) {
    // lastSyncedCommitSha may be null when the repo pre-existed with commits
    // but reconcile never populated the field. Fall back to reading HEAD
    // before giving up.
    const log = await getLog(model.path);
    const latest = log[0];
    if (!latest) {
      throw new ModelHasNoCommitsError("model has no commits yet to pin");
    }
    return { sha: latest.sha, message: latest.message };
  }

  const log = await getLog(model.path);
  const target = validateShaInLog(log, sha);
  return { sha: target.sha, message: target.message };
}

/** The "submodule pointer" — a {model, pinned commit} pair — combined with the model's live state for API responses. */
export function toPinnedModel(pin: ProjectModelPinRow, model: ModelRow): PinnedModel {
  return {
    modelId: model.id,
    modelTitle: model.title,
    thumbnailPath: model.thumbnailPath,
    thumbnailStatus: model.thumbnailStatus,
    modelSyncStatus: model.syncStatus,
    pinnedCommitSha: pin.pinnedCommitSha,
    pinnedCommitMessage: pin.pinnedCommitMessage,
    pinnedAt: pin.pinnedAt.getTime(),
    // Falsy (empty string, same as null) means "no known synced commit yet" —
    // matches resolvePinTarget's own `!sha` check above, so a model whose
    // lastSyncedCommitSha hasn't been populated never shows as outdated.
    isOutdated: !!model.lastSyncedCommitSha && model.lastSyncedCommitSha !== pin.pinnedCommitSha,
  };
}

export function addPin(
  db: DbClient,
  projectId: number,
  modelId: number,
  sha: string,
  message: string,
): ProjectModelPinRow {
  const existing = db
    .select()
    .from(projectModelPinsTable)
    .where(
      and(eq(projectModelPinsTable.projectId, projectId), eq(projectModelPinsTable.modelId, modelId)),
    )
    .get();
  if (existing) {
    throw new ModelAlreadyPinnedError("model is already pinned to this project");
  }

  return db
    .insert(projectModelPinsTable)
    .values({
      projectId,
      modelId,
      pinnedCommitSha: sha,
      pinnedCommitMessage: message,
      pinnedAt: new Date(),
    })
    .returning()
    .get();
}

export function updatePin(
  db: DbClient,
  projectId: number,
  modelId: number,
  sha: string,
  message: string,
): ProjectModelPinRow | undefined {
  return db
    .update(projectModelPinsTable)
    .set({ pinnedCommitSha: sha, pinnedCommitMessage: message, pinnedAt: new Date() })
    .where(
      and(eq(projectModelPinsTable.projectId, projectId), eq(projectModelPinsTable.modelId, modelId)),
    )
    .returning()
    .get();
}

export function removePin(db: DbClient, projectId: number, modelId: number): void {
  db.delete(projectModelPinsTable)
    .where(
      and(eq(projectModelPinsTable.projectId, projectId), eq(projectModelPinsTable.modelId, modelId)),
    )
    .run();
}

/**
 * Whether `modelId` is currently pinned to `projectId` — used by the bulk
 * pins route (api/routes/projects.ts) to report "not pinned to this
 * project" as a per-item failure. The single-item DELETE route doesn't need
 * this (it unconditionally 204s, matching removePin's own no-op-if-absent
 * behavior), but a bulk batch needs to distinguish "removed" from "wasn't
 * there to begin with" for its per-item results.
 */
export function pinExists(db: DbClient, projectId: number, modelId: number): boolean {
  return (
    db
      .select({ modelId: projectModelPinsTable.modelId })
      .from(projectModelPinsTable)
      .where(
        and(eq(projectModelPinsTable.projectId, projectId), eq(projectModelPinsTable.modelId, modelId)),
      )
      .get() != null
  );
}

export function getPinsForProject(db: DbClient, projectId: number): PinnedModel[] {
  const rows = db
    .select({ pin: projectModelPinsTable, model: modelsTable })
    .from(projectModelPinsTable)
    .innerJoin(modelsTable, eq(projectModelPinsTable.modelId, modelsTable.id))
    .where(eq(projectModelPinsTable.projectId, projectId))
    .all();
  return rows.map((r) => toPinnedModel(r.pin, r.model)).sort((a, b) => a.pinnedAt - b.pinnedAt);
}

/** One pin plus its target model's filesystem path — the bits toPinnedModel/PinnedModel deliberately omit (not API-facing) but that project export needs to run git commands against. Deliberately unfiltered by deletedAt: a trashed model's repo is still physically present under LIBRARY_ROOT/.trash/ until purge, so its pin should still be exportable — see the project export route. */
export interface ExportPin {
  pin: PinnedModel;
  modelPath: string;
}

export function getPinsForExport(db: DbClient, projectId: number): ExportPin[] {
  const rows = db
    .select({ pin: projectModelPinsTable, model: modelsTable })
    .from(projectModelPinsTable)
    .innerJoin(modelsTable, eq(projectModelPinsTable.modelId, modelsTable.id))
    .where(eq(projectModelPinsTable.projectId, projectId))
    .all();
  return rows
    .map((r) => ({ pin: toPinnedModel(r.pin, r.model), modelPath: r.model.path }))
    .sort((a, b) => a.pin.pinnedAt - b.pin.pinnedAt);
}

export function getPinsForProjects(db: DbClient, projectIds: number[]): Map<number, PinnedModel[]> {
  const result = new Map<number, PinnedModel[]>();
  if (projectIds.length === 0) return result;

  const rows = db
    .select({ pin: projectModelPinsTable, model: modelsTable })
    .from(projectModelPinsTable)
    .innerJoin(modelsTable, eq(projectModelPinsTable.modelId, modelsTable.id))
    .where(inArray(projectModelPinsTable.projectId, projectIds))
    .all();

  for (const row of rows) {
    const list = result.get(row.pin.projectId) ?? [];
    list.push(toPinnedModel(row.pin, row.model));
    result.set(row.pin.projectId, list);
  }
  for (const list of result.values()) {
    list.sort((a, b) => a.pinnedAt - b.pinnedAt);
  }
  return result;
}
