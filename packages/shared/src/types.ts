export type SyncStatus = "ok" | "error" | "missing";
export type ThumbnailStatus = "pending" | "generating" | "ready" | "error";
export type ThumbnailSource = "auto" | "manual";
export type ModelExtension = "stl" | "3mf" | "obj";
export type ModelSortField = "title" | "createdAt";
export type SortOrder = "asc" | "desc";

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

export interface Tag {
  id: number;
  name: string;
  color: string;
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
  createdAt: number;
  updatedAt: number;
  tags: Tag[];
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

export interface ModelListResult {
  data: Model[];
  total: number;
}

export interface ModelDetail extends Model {
  files: FileEntry[];
  gitLog: GitLogEntry[];
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
  createdAt: number;
  updatedAt: number;
}

export interface ProjectDetail extends Project {
  pins: PinnedModel[];
}
