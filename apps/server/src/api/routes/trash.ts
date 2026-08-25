import { rename, rm } from "node:fs/promises";
import type { TrashedModel } from "@model-hub/shared";
import { desc, eq, isNotNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { models as modelsTable, type ModelRow } from "../../db/schema.js";
import { sanitizeModelDirName } from "../../lib/fs-utils.js";
import { runExclusive } from "../../sync/queue.js";
import { LOCAL_UPLOAD_IDENTITY, reconcileModelCore } from "../../sync/reconcile.js";
import { maybeEnqueueThumbnail } from "../../thumbnails/trigger.js";
import { pickModelDirPath } from "./models.js";

function toTrashedModel(row: ModelRow): TrashedModel {
  return {
    id: row.id,
    title: row.title,
    thumbnailPath: row.thumbnailPath,
    thumbnailStatus: row.thumbnailStatus,
    // Non-null by construction: every row this function is ever called with
    // comes from a deletedAt-IS-NOT-NULL query below.
    deletedAt: row.deletedAt!.getTime(),
  };
}

/**
 * Trash view: list, restore, and permanently-delete for models soft-deleted
 * by DELETE /api/models/:id (see models.ts). A trashed row's `path` column
 * always points at its current LIBRARY_ROOT/.trash/<fsId>-<timestamp>/
 * location — restore/purge lock on that same path via runExclusive, so they
 * naturally serialize against each other and against the background
 * retention sweep (sync/scanner.ts's purgeExpiredTrash), which locks on the
 * identical key. Each handler re-reads the row from the DB *inside* that
 * lock before acting, so whichever of restore/purge/auto-purge wins the race
 * for a given model is the only one that actually touches it.
 */
export function registerTrashRoutes(app: FastifyInstance, db: DbClient, libraryRoot: string): void {
  app.get("/api/trash", async () => {
    const rows = db
      .select()
      .from(modelsTable)
      .where(isNotNull(modelsTable.deletedAt))
      .orderBy(desc(modelsTable.deletedAt))
      .all();
    return rows.map(toTrashedModel);
  });

  app.post<{ Params: { id: string } }>("/api/trash/:id/restore", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const initial = db
      .select()
      .from(modelsTable)
      .where(eq(modelsTable.id, id))
      .get();
    if (!initial || initial.deletedAt == null) {
      return reply.code(404).send({ error: "trashed model not found" });
    }

    const outcome = await runExclusive(initial.path, async () => {
      const fresh = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
      if (!fresh || fresh.deletedAt == null) {
        return { restored: false as const };
      }

      // Recompute the destination the same way a brand-new model's directory
      // is chosen (pickModelDirPath), so a name reused by a different model
      // since this one was trashed gets the usual " (2)", " (3)" treatment
      // instead of colliding.
      const base = sanitizeModelDirName(fresh.title) ?? fresh.fsId;
      const targetPath = await pickModelDirPath(libraryRoot, db, base);
      await rename(fresh.path, targetPath);

      db.update(modelsTable)
        .set({ path: targetPath, deletedAt: null, missingSince: null, updatedAt: new Date() })
        .where(eq(modelsTable.id, id))
        .run();

      const result = await reconcileModelCore(
        db,
        { ...fresh, path: targetPath },
        { identity: LOCAL_UPLOAD_IDENTITY, commitMessage: "Restored from trash" },
      );
      return { restored: true as const, result };
    });

    if (!outcome.restored) {
      return reply.code(404).send({ error: "trashed model not found" });
    }
    if (outcome.result.status === "error") {
      return reply.code(500).send({ error: outcome.result.error });
    }

    const updatedRow = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get()!;
    maybeEnqueueThumbnail(db, updatedRow, outcome.result);

    return reply.code(200).send({ ok: true, path: updatedRow.path });
  });

  app.delete<{ Params: { id: string } }>("/api/trash/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid model id" });
    }

    const initial = db
      .select()
      .from(modelsTable)
      .where(eq(modelsTable.id, id))
      .get();
    if (!initial || initial.deletedAt == null) {
      return reply.code(404).send({ error: "trashed model not found" });
    }

    const purged = await runExclusive(initial.path, async () => {
      const fresh = db.select().from(modelsTable).where(eq(modelsTable.id, id)).get();
      if (!fresh || fresh.deletedAt == null) return false;
      await rm(fresh.path, { recursive: true, force: true });
      db.delete(modelsTable).where(eq(modelsTable.id, id)).run();
      return true;
    });

    if (!purged) {
      return reply.code(404).send({ error: "trashed model not found" });
    }
    return reply.code(204).send();
  });
}
