import { classifyAttachmentExtension, type ModelExtension } from "@model-hub/shared"

export function fileUrl(modelId: number, relativePath: string): string {
  return `/api/models/${modelId}/files/${relativePath.split("/").map(encodeURIComponent).join("/")}`
}

export function archiveUrl(modelId: number): string {
  return `/api/models/${modelId}/download`
}

/** Unlike archiveUrl (plain files-only zip, no metadata), this also bundles a metadata.json sidecar — see GET /api/models/:id/export. */
export function modelExportUrl(modelId: number): string {
  return `/api/models/${modelId}/export`
}

/**
 * Saves a Blob as a file download without navigating away — used for the
 * multi/all-model export, which (unlike the single-model export above) has
 * to be triggered via a POST with a JSON body, so a plain `<a href download>`
 * link can't drive it; the response is fetched as a Blob instead and this
 * simulates the browser's own download-link click for it.
 */
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
