export type SyncStatus = "ok" | "error" | "missing";
export type ThumbnailStatus = "pending" | "generating" | "ready" | "error";
export type ThumbnailSource = "auto" | "manual";
/** "none": no sourceUrl set. "pending": a snapshot fetch is queued/in flight. "ready"/"error" are terminal until the next save or manual refresh. */
export type SourceSnapshotStatus = "none" | "pending" | "ready" | "error";
export type ModelExtension = "stl" | "3mf" | "obj";
export type ModelSortField = "title" | "createdAt" | "lastSyncedAt";
export type SortOrder = "asc" | "desc";

/**
 * Image/PDF extensions recognized as model *attachments* (build photos,
 * instruction sheets) — a first-class file category distinct from
 * ModelExtension. Never a candidate for the 3D viewer or the
 * primary-file/thumbnail-source ranking (see apps/server/src/lib/fs-utils.ts's
 * EXTENSION_RANK and pickPrimaryFile). Kept here (not just server-side) since
 * the web app also needs to classify a FileEntry to decide gallery-vs-pdf
 * rendering in the Attachments tab.
 */
export const ATTACHMENT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"] as const;
export const ATTACHMENT_PDF_EXTENSIONS = ["pdf"] as const;
export type AttachmentKind = "image" | "pdf";

/** Classifies a file extension as an attachment kind, or null if it's not an attachment (e.g. a model file). */
export function classifyAttachmentExtension(extension: string): AttachmentKind | null {
  const ext = extension.toLowerCase();
  if ((ATTACHMENT_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  if ((ATTACHMENT_PDF_EXTENSIONS as readonly string[]).includes(ext)) return "pdf";
  return null;
}

/**
 * admin: full access, including user/role management and instance settings.
 * editor: create/upload/edit/tag/favorite models and projects, but cannot
 *   delete models/projects, manage users, or change instance settings.
 * viewer: read-only — browse, view, download, no mutations.
 */
export type UserRole = "admin" | "editor" | "viewer";

export interface AdminUser {
  id: number;
  name: string | null;
  email: string | null;
  role: UserRole;
  isLocalOwner: boolean;
  createdAt: number;
}

/** One "OIDC group claim value -> app role" rule. */
export interface OidcRoleMapping {
  id: number;
  groupName: string;
  role: UserRole;
}

export interface OidcRoleMappingConfig {
  // The claim in the ID token whose value lists the user's OIDC groups
  // (provider-specific — e.g. "groups" for Authelia/Authentik/Keycloak).
  groupsClaim: string;
  // Role assigned when none of a user's groups match a mapping below.
  defaultRole: UserRole;
  mappings: OidcRoleMapping[];
}

/**
 * A personal API token's public metadata — never includes the token secret
 * itself, which is only ever returned once, at creation (see ApiTokenCreated
 * below). Authenticates as its owning user with their current role, via
 * `Authorization: Bearer <token>`.
 */
export interface ApiToken {
  id: number;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

/** Returned only from the create-token endpoint — `token` is the plaintext secret, shown exactly once and unrecoverable after that. */
export interface ApiTokenCreated extends ApiToken {
  token: string;
}

/**
 * Global, instance-wide snapshot for the Settings/Stats page (issue #73) —
 * deliberately not scoped to any user, model, or project. Backed by
 * apps/server/src/api/routes/stats.ts, which reuses issue #71's Prometheus
 * metrics data (thumbnail queue state, last-scan stats) rather than
 * recomputing them a second way.
 */
export interface InstanceStats {
  storage: {
    /** Actual bytes used under LIBRARY_ROOT on disk (recursive, includes .git/.thumbnails). */
    libraryUsedBytes: number;
    /** Total size of the volume LIBRARY_ROOT is mounted on. */
    volumeTotalBytes: number;
    /** Free space on that volume, including the portion reserved for root. */
    volumeFreeBytes: number;
    /** Free space on that volume available to unprivileged users. */
    volumeAvailableBytes: number;
  };
  counts: {
    /** Active (non-trashed) models only. */
    models: number;
    projects: number;
    tags: number;
    /** Active models grouped by thumbnailStatus — every ThumbnailStatus key is always present, defaulting to 0. */
    thumbnailStatus: Record<ThumbnailStatus, number>;
  };
  thumbnailQueue: {
    /** Jobs queued but not yet started. */
    pending: number;
    /** Jobs currently rendering. */
    active: number;
  };
  sync: {
    /** Unix ms timestamp the most recent full-library scan finished, or null if none has completed since this process started. */
    lastScanAt: number | null;
    lastScanDurationSeconds: number | null;
    /** Active models currently in syncStatus "error". */
    errorModelCount: number;
    /** Active models currently in syncStatus "missing". */
    missingModelCount: number;
  };
  instance: {
    version: string;
    oidcEnabled: boolean;
    libraryRoot: string;
  };
}

export interface Tag {
  id: number;
  name: string;
  color: string;
}

/** One other active model this model shares an identical-content file with — see lib/duplicates.ts. */
export interface DuplicateModelRef {
  modelId: number;
  modelTitle: string;
}

export interface TagWithCount extends Tag {
  modelCount: number;
}

export interface Model {
  id: number;
  fsId: string;
  path: string;
  title: string;
  description: string;
  primaryFilePath: string | null;
  thumbnailPath: string | null;
  thumbnailStatus: ThumbnailStatus;
  thumbnailSource: ThumbnailSource;
  lastSyncedCommitSha: string | null;
  lastSyncedAt: number | null;
  syncStatus: SyncStatus;
  syncError: string | null;
  missingSince: number | null;
  favorite: boolean;
  // Where this model came from (Thingiverse/Printables/MakerWorld/etc.), or
  // null if unset. See sourceSnapshotStatus for the anti-link-rot HTML
  // snapshot fetched from this URL — see ModelDetail.sourceSnapshotHtml for
  // the (sanitized) snapshot content itself, only present on the detail
  // response.
  sourceUrl: string | null;
  sourceSnapshotStatus: SourceSnapshotStatus;
  sourceSnapshotError: string | null;
  sourceSnapshotFetchedAt: number | null;
  // Always null on every Model returned by the normal model routes (they
  // filter trashed rows out) — present so a trashed model briefly in flight
  // through a shared code path still type-checks. See TrashedModel for the
  // shape actually used by the Trash view.
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  tags: Tag[];
  // Other active models sharing a file with an identical content hash — see
  // lib/duplicates.ts. Empty when this model has no flagged duplicates.
  duplicateModels: DuplicateModelRef[];
}

/** One row in the Trash view — a model whose directory was moved to LIBRARY_ROOT/.trash/ pending restore or auto-purge. */
export interface TrashedModel {
  id: number;
  title: string;
  thumbnailPath: string | null;
  thumbnailStatus: ThumbnailStatus;
  deletedAt: number;
}

export interface FileEntry {
  relativePath: string;
  sizeBytes: number;
  mtime: number;
  extension: string;
}

export interface GitLogEntry {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

/** One path's change between two commits, from `git diff --name-status`. */
export interface FileChangeEntry {
  path: string;
  status: "added" | "modified" | "removed";
}

/**
 * The response of GET /api/models/:id/diff?from=<sha>&to=<sha> — the
 * intervening commit log (see GitLogEntry) plus a file-level change list,
 * used by the project pin-bump UI to preview a bump before confirming it.
 * No geometric/visual mesh diff — file-list only, see issue #68.
 */
export interface ModelDiff {
  commits: GitLogEntry[];
  files: FileChangeEntry[];
}

export interface ModelListResult {
  data: Model[];
  total: number;
}

export interface ModelDetail extends Model {
  files: FileEntry[];
  // Image/PDF files (see classifyAttachmentExtension) found in the model
  // directory, kept separate from `files` (which stays model-file-only, as
  // it was before attachments existed) so the Attachments tab doesn't need
  // to re-filter, and so `files` continues to be exactly the set of viewer/
  // primary-file candidates.
  attachments: FileEntry[];
  gitLog: GitLogEntry[];
  // Sanitized (server-side, before storage — see the server's
  // lib/sanitize-html.ts) HTML of the last successful sourceUrl fetch, or
  // null if none has ever succeeded. Still render this inside a script-less
  // sandboxed iframe (defense in depth) rather than trusting sanitization
  // alone — see apps/web/src/routes/model-detail.tsx's snapshot viewer.
  sourceSnapshotHtml: string | null;
}

/** One {model, pinned commit} pair within a Project — the "submodule pointer." */
export interface PinnedModel {
  modelId: number;
  modelTitle: string;
  thumbnailPath: string | null;
  thumbnailStatus: ThumbnailStatus;
  // Lets the Project UI flag a pinned model whose directory has gone missing.
  modelSyncStatus: SyncStatus;
  pinnedCommitSha: string;
  pinnedCommitMessage: string;
  pinnedAt: number;
  // True when pinnedCommitSha no longer matches the model's current lastSyncedCommitSha.
  isOutdated: boolean;
}

export interface Project {
  id: number;
  title: string;
  description: string;
  pinCount: number;
  // First few pins, for a list-view thumbnail mosaic without an extra fetch per project.
  previewPins: Pick<PinnedModel, "modelId" | "thumbnailPath" | "thumbnailStatus">[];
  // True when a custom thumbnail (uploaded via POST /api/projects/:id/thumbnail)
  // is set — fetch it from GET /api/projects/:id/thumbnail. When false, the
  // web app falls back to the auto-generated mosaic of previewPins.
  hasCustomThumbnail: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * A persistent, dismissible notice on a project — currently used only for
 * "a pinned model was permanently removed from the library" (see issue #69
 * and the server's lib/project-notices.ts). Not a general activity timeline.
 */
export interface ProjectActivityNotice {
  id: number;
  message: string;
  createdAt: number;
}

export interface ProjectDetail extends Project {
  pins: PinnedModel[];
  // Non-dismissed notices only — see lib/project-notices.ts's getActiveNoticesForProject.
  notices: ProjectActivityNotice[];
}
