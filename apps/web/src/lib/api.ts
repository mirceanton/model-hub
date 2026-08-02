import type { Project, ProjectDetail } from "@model-hub/shared"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request to ${path} failed with status ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function fetchProjects(): Promise<Project[]> {
  return request<Project[]>("/api/projects")
}

export function fetchProject(id: number): Promise<ProjectDetail> {
  return request<ProjectDetail>(`/api/projects/${id}`)
}

export interface UploadResult {
  ok: true
  committed: boolean
  writtenFiles: string[]
  skippedFiles: string[]
}

export function uploadProjectVersion(
  id: number,
  files: File[],
  message: string,
): Promise<UploadResult> {
  const formData = new FormData()
  for (const file of files) formData.append("files", file, file.name)
  formData.append("message", message)
  return request<UploadResult>(`/api/projects/${id}/upload`, { method: "POST", body: formData })
}

export interface RestoreResult {
  ok: true
  committed: boolean
}

export function restoreProjectVersion(id: number, sha: string): Promise<RestoreResult> {
  return request<RestoreResult>(`/api/projects/${id}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sha }),
  })
}

export interface RegenerateThumbnailResult {
  ok: true
  thumbnailStatus: "pending"
}

export function regenerateThumbnail(id: number): Promise<RegenerateThumbnailResult> {
  return request<RegenerateThumbnailResult>(`/api/projects/${id}/thumbnail/regenerate`, {
    method: "POST",
  })
}
