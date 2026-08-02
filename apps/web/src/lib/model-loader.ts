import type { ModelExtension } from "@model-hub/shared"

export function fileUrl(projectId: number, relativePath: string): string {
  return `/api/projects/${projectId}/files/${relativePath.split("/").map(encodeURIComponent).join("/")}`
}

export function isViewableExtension(extension: string): extension is ModelExtension {
  return extension === "stl" || extension === "3mf"
}
