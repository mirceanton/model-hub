import type { ModelExtension } from "@model-hub/shared"

export function fileUrl(modelId: number, relativePath: string): string {
  return `/api/models/${modelId}/files/${relativePath.split("/").map(encodeURIComponent).join("/")}`
}

/** `cacheBust` should be the model's updatedAt so a regenerated thumbnail is refetched without a hard reload. */
export function thumbnailUrl(modelId: number, cacheBust: number): string {
  return `/api/models/${modelId}/thumbnail?v=${cacheBust}`
}

export function isViewableExtension(extension: string): extension is ModelExtension {
  return extension === "stl" || extension === "3mf" || extension === "obj"
}
