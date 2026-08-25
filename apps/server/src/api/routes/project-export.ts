import { extname } from "node:path";
import { ZipArchive, type ArchiverError } from "archiver";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DbClient } from "../../db/client.js";
import { projects as projectsTable } from "../../db/schema.js";
import { isDotPath, isTrackedExtension, makeDirNamePicker, sanitizeModelDirName } from "../../lib/fs-utils.js";
import { getPinsForExport } from "../../lib/project-pins.js";
import { catFileBlobStream, listFilesAtCommit } from "../../sync/git.js";

interface ExportManifestModel {
  modelId: number;
  modelTitle: string;
  /** The subdirectory this model's files were written under, inside the zip. */
  directory: string;
  pinnedCommitSha: string;
  pinnedCommitMessage: string;
  /** True when the model has moved on to a different commit since it was pinned — same flag as PinnedModel.isOutdated. */
  isOutdated: boolean;
  fileCount: number;
  /** Set (and fileCount left at 0) when this model's pinned commit couldn't be read — e.g. its repo went missing. The rest of the export still proceeds. */
  exportError: string | null;
}

interface ExportManifest {
  projectId: number;
  projectTitle: string;
  projectDescription: string;
  exportedAt: string;
  models: ExportManifestModel[];
}

/**
 * GET /api/projects/:id/export — a single zip bundling every pinned model's
 * files AS THEY EXISTED AT THE PINNED COMMIT (not the model's current
 * on-disk state), which is the whole point of a pin — the git-submodule
 * analogy from CLAUDE.md's Projects section. Reads each model's git objects
 * directly (sync/git.ts's listFilesAtCommit + catFileBlobStream) rather than
 * the live working tree, and streams blob content straight into the archive
 * without buffering a whole file (let alone the whole zip) in memory —
 * same archiver/ZipArchive streaming pattern as GET /api/models/:id/download
 * (download.ts).
 *
 * Deliberately NOT filtered to active-only models (getPinsForExport is
 * unfiltered by deletedAt): a pin to a currently-trashed model still exports
 * fine, since the model's git repo is still physically present under
 * LIBRARY_ROOT/.trash/ until purge — only a hard-deleted model has no repo
 * left, and by that point its pin has already been silently dropped (see
 * CLAUDE.md's Projects section on cascade-on-delete), so there's nothing to
 * special-case for that. A model whose repo is unreadable for some other
 * reason (corrupt, moved unexpectedly) doesn't abort the whole export —
 * its manifest entry just carries an exportError and no files.
 */
export function registerProjectExportRoutes(app: FastifyInstance, db: DbClient): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/export", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) {
      return reply.code(400).send({ error: "invalid project id" });
    }

    const project = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
    if (!project) {
      return reply.code(404).send({ error: "project not found" });
    }

    const pins = getPinsForExport(db, id);
    const pickDirName = makeDirNamePicker();

    reply.header("Content-Type", "application/zip");
    const zipFilename = sanitizeModelDirName(project.title) ?? "project";
    reply.header("Content-Disposition", `attachment; filename="${zipFilename}.zip"`);

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("warning", (err: ArchiverError) => request.log.warn(err));
    archive.on("error", (err: ArchiverError) => request.log.error(err));

    const manifest: ExportManifest = {
      projectId: project.id,
      projectTitle: project.title,
      projectDescription: project.description,
      exportedAt: new Date().toISOString(),
      models: [],
    };

    for (const { pin, modelPath } of pins) {
      const directory = pickDirName(pin.modelTitle, pin.modelId);
      const manifestEntry: ExportManifestModel = {
        modelId: pin.modelId,
        modelTitle: pin.modelTitle,
        directory,
        pinnedCommitSha: pin.pinnedCommitSha,
        pinnedCommitMessage: pin.pinnedCommitMessage,
        isOutdated: pin.isOutdated,
        fileCount: 0,
        exportError: null,
      };

      try {
        // Filtered to the same allowlist listModelFiles applies when walking
        // the live working tree (model files + attachments, no dotfiles) —
        // ls-tree at an arbitrary historical commit has no DB `files` cache
        // to filter through, so this reapplies the same rule directly.
        const entries = (await listFilesAtCommit(modelPath, pin.pinnedCommitSha)).filter(
          (entry) => !isDotPath(entry.path) && isTrackedExtension(extname(entry.path).slice(1)),
        );
        for (const entry of entries) {
          archive.append(catFileBlobStream(modelPath, entry.blobSha), {
            name: `${directory}/${entry.path}`,
          });
        }
        manifestEntry.fileCount = entries.length;
      } catch (err) {
        request.log.warn(
          { err, modelId: pin.modelId, sha: pin.pinnedCommitSha },
          "project export: failed to read pinned commit for model",
        );
        manifestEntry.exportError = err instanceof Error ? err.message : String(err);
      }

      manifest.models.push(manifestEntry);
    }

    archive.append(JSON.stringify(manifest, null, 2), { name: "project.json" });

    void archive.finalize();
    return reply.send(archive);
  });
}
