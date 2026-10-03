export type SyncStatus = "ok" | "error" | "missing";
export type ThumbnailStatus = "pending" | "generating" | "ready" | "error";
export type ThumbnailSource = "auto" | "manual";
export type ModelExtension = "stl" | "3mf" | "obj" | "step" | "stp";
export type ModelSortField = "title" | "createdAt" | "lastSyncedAt";
export type SortOrder = "asc" | "desc";

export const ATTACHMENT_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"] as const;
export const ATTACHMENT_PDF_EXTENSIONS = ["pdf"] as const;
export type AttachmentKind = "image" | "pdf";

export function classifyAttachmentExtension(extension: string): AttachmentKind | null {
  const ext = extension.toLowerCase();
  if ((ATTACHMENT_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return "image";
  if ((ATTACHMENT_PDF_EXTENSIONS as readonly string[]).includes(ext)) return "pdf";
  return null;
}

export type UserRole = "admin" | "editor" | "viewer";

export interface AdminUser {
  id: number;
  name: string | null;
  email: string | null;
  role: UserRole;
  isLocalOwner: boolean;
  createdAt: number;
}

export interface OidcRoleMapping {
  id: number;
  groupName: string;
  role: UserRole;
  lockedBy: string | null;
}

export interface OidcRoleMappingConfig {
  groupsClaim: string;
  groupsClaimLockedBy: string | null;
  defaultRole: UserRole | null;
  defaultRoleLockedBy: string | null;
  mappings: OidcRoleMapping[];
}

export type ConfigCategory = "library" | "server" | "thumbnails" | "sso" | "rate-limiting";

export type ConfigValueSource = "env" | "override" | "default" | "unset";

export interface ConfigItem {
  key: string;
  label: string;
  description: string;
  category: ConfigCategory;
  secret: boolean;
  editable: boolean;
  source: ConfigValueSource;
  value: string | null;
}

export interface ApiToken {
  id: number;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

export interface ApiTokenCreated extends ApiToken {
  token: string;
}

export interface InstanceStats {
  storage: {
    libraryUsedBytes: number;
    volumeTotalBytes: number;
    volumeFreeBytes: number;
    volumeAvailableBytes: number;
  };
  counts: {
    models: number;
    projects: number;
    tags: number;
    thumbnailStatus: Record<ThumbnailStatus, number>;
  };
  thumbnailQueue: {
    pending: number;
    active: number;
  };
  sync: {
    lastScanAt: number | null;
    lastScanDurationSeconds: number | null;
    errorModelCount: number;
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
  sourceUrl: string | null;
  deletedAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  tags: Tag[];
  duplicateModels: DuplicateModelRef[];
}

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

export interface FileChangeEntry {
  path: string;
  status: "added" | "modified" | "removed";
}

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
  attachments: FileEntry[];
  gitLog: GitLogEntry[];
}

export interface PinnedModel {
  modelId: number;
  modelTitle: string;
  thumbnailPath: string | null;
  thumbnailStatus: ThumbnailStatus;
  modelSyncStatus: SyncStatus;
  pinnedCommitSha: string;
  pinnedCommitMessage: string;
  pinnedAt: number;
  isOutdated: boolean;
  printedAt: number | null;
}

export interface Project {
  id: number;
  title: string;
  description: string;
  pinCount: number;
  previewPins: Pick<PinnedModel, "modelId" | "thumbnailPath" | "thumbnailStatus">[];
  hasCustomThumbnail: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectActivityNotice {
  id: number;
  message: string;
  createdAt: number;
}

export interface ProjectDetail extends Project {
  pins: PinnedModel[];
  notices: ProjectActivityNotice[];
}

export interface BulkResult<TId = number> {
  id: TId;
  success: boolean;
  error?: string;
}

export interface BulkResponse<TId = number> {
  results: BulkResult<TId>[];
}

export type ModelBulkAction =
  | "delete"
  | "favorite"
  | "unfavorite"
  | "archive"
  | "unarchive"
  | "add-tag"
  | "remove-tag";

export interface ModelsBulkRequest {
  ids: number[];
  action: ModelBulkAction;
  tagName?: string;
  tagId?: number;
}

export interface ModelFilesBulkRequest {
  ids: string[];
  action: "delete";
}

export type ProjectPinsBulkAction = "remove" | "bump" | "mark-printed" | "mark-unprinted";

export interface ProjectPinsBulkRequest {
  ids: number[];
  action: ProjectPinsBulkAction;
}

export type ProjectBulkAction = "delete" | "archive" | "unarchive";

export interface ProjectsBulkRequest {
  ids: number[];
  action: ProjectBulkAction;
}