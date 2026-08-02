export type SyncStatus = "ok" | "error" | "missing";
export type ThumbnailStatus = "pending" | "generating" | "ready" | "error";
export type ModelExtension = "stl" | "3mf";

export interface Tag {
  id: number;
  name: string;
  color: string;
}

export interface TagWithCount extends Tag {
  projectCount: number;
}

export interface Project {
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

export interface ProjectDetail extends Project {
  files: FileEntry[];
  gitLog: GitLogEntry[];
}
