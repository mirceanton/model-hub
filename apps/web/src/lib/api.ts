import type { Project, ProjectDetail, Tag, TagWithCount } from "@model-hub/shared"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request to ${path} failed with status ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export interface ProjectFilters {
  q?: string
  tag?: string
}

export function fetchProjects(filters: ProjectFilters = {}): Promise<Project[]> {
  const params = new URLSearchParams()
  if (filters.q) params.set("q", filters.q)
  if (filters.tag) params.set("tag", filters.tag)
  const query = params.toString()
  return request<Project[]>(`/api/projects${query ? `?${query}` : ""}`)
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

export function fetchTags(): Promise<TagWithCount[]> {
  return request<TagWithCount[]>("/api/tags")
}

export function addProjectTag(projectId: number, name: string): Promise<Tag> {
  return request<Tag>(`/api/projects/${projectId}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
}

export function removeProjectTag(projectId: number, tagId: number): Promise<void> {
  return request<void>(`/api/projects/${projectId}/tags/${tagId}`, { method: "DELETE" })
}
