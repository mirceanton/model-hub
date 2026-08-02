import type { ModelExtension } from "@model-hub/shared"

export function fileUrl(projectId: number, relativePath: string): string {
  return `/api/projects/${projectId}/files/${relativePath.split("/").map(encodeURIComponent).join("/")}`
}

/** `cacheBust` should be the project's updatedAt so a regenerated thumbnail is refetched without a hard reload. */
export function thumbnailUrl(projectId: number, cacheBust: number): string {
  return `/api/projects/${projectId}/thumbnail?v=${cacheBust}`
}

export function isViewableExtension(extension: string): extension is ModelExtension {
  return extension === "stl" || extension === "3mf"
}
