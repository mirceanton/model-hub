import { classifyAttachmentExtension, type ModelExtension } from "@model-hub/shared"

export function fileUrl(modelId: number, relativePath: string): string {
  return `/api/models/${modelId}/files/${relativePath.split("/").map(encodeURIComponent).join("/")}`
}

export function archiveUrl(modelId: number): string {
  return `/api/models/${modelId}/download`
}

/** `cacheBust` should be the model's updatedAt so a regenerated thumbnail is refetched without a hard reload. */
export function thumbnailUrl(modelId: number, cacheBust: number): string {
  return `/api/models/${modelId}/thumbnail?v=${cacheBust}`
}

/** `cacheBust` should be the project's updatedAt so a newly uploaded custom thumbnail is refetched without a hard reload. */
export function projectThumbnailUrl(projectId: number, cacheBust: number): string {
  return `/api/projects/${projectId}/thumbnail?v=${cacheBust}`
}

export function projectExportUrl(projectId: number): string {
  return `/api/projects/${projectId}/export`
}

export function isViewableExtension(extension: string): extension is ModelExtension {
  return extension === "stl" || extension === "3mf" || extension === "obj"
}

export function isImageAttachment(extension: string): boolean {
  return classifyAttachmentExtension(extension) === "image"
}

export function isPdfAttachment(extension: string): boolean {
  return classifyAttachmentExtension(extension) === "pdf"
}
