export type SyncStatus = "ok" | "error" | "missing";
export type ThumbnailStatus = "pending" | "generating" | "ready" | "error";
export type ModelExtension = "stl" | "3mf";

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
