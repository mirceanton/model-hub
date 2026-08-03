import type {
  Model,
  ModelDetail,
  PinnedModel,
  Project,
  ProjectDetail,
  Tag,
  TagWithCount,
} from "@model-hub/shared"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request to ${path} failed with status ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export interface ModelFilters {
  q?: string
  tag?: string
  favorite?: boolean
}

export function fetchModels(filters: ModelFilters = {}): Promise<Model[]> {
  const params = new URLSearchParams()
  if (filters.q) params.set("q", filters.q)
  if (filters.tag) params.set("tag", filters.tag)
  if (filters.favorite) params.set("favorite", "true")
  const query = params.toString()
  return request<Model[]>(`/api/models${query ? `?${query}` : ""}`)
}

export function fetchModel(id: number): Promise<ModelDetail> {
  return request<ModelDetail>(`/api/models/${id}`)
}

export function updateModel(
  id: number,
  patch: { title?: string; description?: string; favorite?: boolean },
): Promise<Model> {
  return request<Model>(`/api/models/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
}

export function forgetModel(id: number): Promise<void> {
  return request<void>(`/api/models/${id}`, { method: "DELETE" })
}

export interface UploadResult {
  ok: true
  committed: boolean
  writtenFiles: string[]
  skippedFiles: string[]
}

export function uploadModelVersion(
  id: number,
  files: File[],
  message: string,
): Promise<UploadResult> {
  const formData = new FormData()
  for (const file of files) formData.append("files", file, file.name)
  formData.append("message", message)
  return request<UploadResult>(`/api/models/${id}/upload`, { method: "POST", body: formData })
}

export interface RestoreResult {
  ok: true
  committed: boolean
}

export function restoreModelVersion(id: number, sha: string): Promise<RestoreResult> {
  return request<RestoreResult>(`/api/models/${id}/restore`, {
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
  return request<RegenerateThumbnailResult>(`/api/models/${id}/thumbnail/regenerate`, {
    method: "POST",
  })
}

export function fetchTags(): Promise<TagWithCount[]> {
  return request<TagWithCount[]>("/api/tags")
}

export function createTag(name: string): Promise<Tag> {
  return request<Tag>("/api/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
}

export function updateTag(id: number, patch: { name?: string; color?: string }): Promise<Tag> {
  return request<Tag>(`/api/tags/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
}

export function deleteTag(id: number): Promise<void> {
  return request<void>(`/api/tags/${id}`, { method: "DELETE" })
}

export function addModelTag(modelId: number, name: string): Promise<Tag> {
  return request<Tag>(`/api/models/${modelId}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  })
}

export function removeModelTag(modelId: number, tagId: number): Promise<void> {
  return request<void>(`/api/models/${modelId}/tags/${tagId}`, { method: "DELETE" })
}

export interface ProjectFilters {
  q?: string
}

export function fetchProjects(filters: ProjectFilters = {}): Promise<Project[]> {
  const params = new URLSearchParams()
  if (filters.q) params.set("q", filters.q)
  const query = params.toString()
  return request<Project[]>(`/api/projects${query ? `?${query}` : ""}`)
}

export function fetchProject(id: number): Promise<ProjectDetail> {
  return request<ProjectDetail>(`/api/projects/${id}`)
}

export function createProject(input: { title: string; description?: string }): Promise<Project> {
  return request<Project>("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}

export function updateProject(
  id: number,
  patch: { title?: string; description?: string },
): Promise<Project> {
  return request<Project>(`/api/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
}

export function deleteProject(id: number): Promise<void> {
  return request<void>(`/api/projects/${id}`, { method: "DELETE" })
}

export function addProjectPin(
  projectId: number,
  input: { modelId: number; commitSha?: string },
): Promise<PinnedModel> {
  return request<PinnedModel>(`/api/projects/${projectId}/pins`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}

export function updateProjectPin(
  projectId: number,
  modelId: number,
  commitSha?: string,
): Promise<PinnedModel> {
  return request<PinnedModel>(`/api/projects/${projectId}/pins/${modelId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commitSha }),
  })
}

export function removeProjectPin(projectId: number, modelId: number): Promise<void> {
  return request<void>(`/api/projects/${projectId}/pins/${modelId}`, { method: "DELETE" })
}

export interface AuthUser {
  id: number
  name: string | null
  email: string | null
}

export interface AuthMe {
  authenticated: boolean
  user: AuthUser | null
  oidcEnabled: boolean
}

export function fetchAuthMe(): Promise<AuthMe> {
  return request<AuthMe>("/api/auth/me")
}

export function logout(): Promise<void> {
  return request<void>("/auth/logout", { method: "POST" })
}
