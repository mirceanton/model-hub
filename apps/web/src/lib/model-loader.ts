import { classifyAttachmentExtension, type ModelExtension } from "@model-hub/shared"

export function fileUrl(modelId: number, relativePath: string): string {
  return `/api/models/${modelId}/files/${relativePath.split("/").map(encodeURIComponent).join("/")}`
}

export function archiveUrl(modelId: number): string {
  return `/api/models/${modelId}/download`
}

export function modelExportUrl(modelId: number): string {
  return `/api/models/${modelId}/export`
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function thumbnailUrl(modelId: number, cacheBust: number): string {
  return `/api/models/${modelId}/thumbnail?v=${cacheBust}`
}

export function projectThumbnailUrl(projectId: number, cacheBust: number): string {
  return `/api/projects/${projectId}/thumbnail?v=${cacheBust}`
}

export function projectExportUrl(projectId: number): string {
  return `/api/projects/${projectId}/export`
}

export function isViewableExtension(extension: string): extension is ModelExtension {
  return extension === "stl" || extension === "3mf" || extension === "obj" || extension === "step" || extension === "stp"
}

export function isImageAttachment(extension: string): boolean {
  return classifyAttachmentExtension(extension) === "image"
}

export function isPdfAttachment(extension: string): boolean {
  return classifyAttachmentExtension(extension) === "pdf"
}