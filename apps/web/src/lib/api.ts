import type {
  AdminUser,
  Model,
  ModelDetail,
  ModelListResult,
  ModelSortField,
  OidcRoleMapping,
  OidcRoleMappingConfig,
  PinnedModel,
  Project,
  ProjectDetail,
  SortOrder,
  Tag,
  TagWithCount,
  TrashedModel,
  UserRole,
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
  /** All listed tags must match (AND) — sent as repeated `?tag=` params. */
  tags?: string[]
  favorite?: boolean
  page?: number
  perPage?: number
  sort?: ModelSortField
  order?: SortOrder
}

export function fetchModels(filters: ModelFilters = {}): Promise<ModelListResult> {
  const params = new URLSearchParams()
  if (filters.q) params.set("q", filters.q)
  for (const tag of filters.tags ?? []) params.append("tag", tag)
  if (filters.favorite) params.set("favorite", "true")
  if (filters.perPage) params.set("perPage", String(filters.perPage))
  if (filters.page) params.set("page", String(filters.page))
  if (filters.sort) params.set("sort", filters.sort)
  if (filters.order) params.set("order", filters.order)
  const query = params.toString()
  return request<ModelListResult>(`/api/models${query ? `?${query}` : ""}`)
}

export function fetchModel(id: number): Promise<ModelDetail> {
  return request<ModelDetail>(`/api/models/${id}`)
}

export function updateModel(
  id: number,
  patch: {
    title?: string
    description?: string
    favorite?: boolean
    primaryFilePath?: string
    sourceUrl?: string | null
  },
): Promise<Model> {
  return request<Model>(`/api/models/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
}

export function createModel(input: {
  title: string
  tags: string[]
  files: File[]
  sourceUrl?: string
}): Promise<Model> {
  const formData = new FormData()
  // Server derives the library directory from "title" before it can stream
  // "files" parts in, so title (and tags/sourceUrl) must be appended before files.
  formData.append("title", input.title)
  for (const tag of input.tags) formData.append("tags", tag)
  if (input.sourceUrl) formData.append("sourceUrl", input.sourceUrl)
  for (const file of input.files) formData.append("files", file, file.name)
  return request<Model>("/api/models", { method: "POST", body: formData })
}

export function deleteModel(id: number): Promise<void> {
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

export interface DeleteFileResult {
  ok: true
  committed: boolean
}

export function deleteModelFile(modelId: number, relativePath: string): Promise<DeleteFileResult> {
  const path = relativePath.split("/").map(encodeURIComponent).join("/")
  return request<DeleteFileResult>(`/api/models/${modelId}/files/${path}`, { method: "DELETE" })
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

export interface CaptureThumbnailResult {
  ok: true
  thumbnailStatus: "ready"
}

export function captureThumbnail(id: number, image: Blob): Promise<CaptureThumbnailResult> {
  const formData = new FormData()
  formData.append("thumbnail", image, "thumb.png")
  return request<CaptureThumbnailResult>(`/api/models/${id}/thumbnail/capture`, {
    method: "POST",
    body: formData,
  })
}

export interface RefreshSourceSnapshotResult {
  ok: true
  sourceSnapshotStatus: "pending"
}

export function refreshSourceSnapshot(id: number): Promise<RefreshSourceSnapshotResult> {
  return request<RefreshSourceSnapshotResult>(`/api/models/${id}/source-snapshot/refresh`, {
    method: "POST",
  })
}

export function fetchTrash(): Promise<TrashedModel[]> {
  return request<TrashedModel[]>("/api/trash")
}

export interface RestoreFromTrashResult {
  ok: true
  path: string
}

export function restoreFromTrash(id: number): Promise<RestoreFromTrashResult> {
  return request<RestoreFromTrashResult>(`/api/trash/${id}/restore`, { method: "POST" })
}

export function purgeFromTrash(id: number): Promise<void> {
  return request<void>(`/api/trash/${id}`, { method: "DELETE" })
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
  role: UserRole
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

export function fetchAdminUsers(): Promise<AdminUser[]> {
  return request<AdminUser[]>("/api/admin/users")
}

export function fetchRoleMapping(): Promise<OidcRoleMappingConfig> {
  return request<OidcRoleMappingConfig>("/api/admin/role-mapping")
}

export function updateRoleMappingSettings(patch: {
  groupsClaim?: string
  defaultRole?: UserRole
}): Promise<{ groupsClaim: string; defaultRole: UserRole }> {
  return request("/api/admin/role-mapping/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
}

export function createRoleMapping(input: { groupName: string; role: UserRole }): Promise<OidcRoleMapping> {
  return request<OidcRoleMapping>("/api/admin/role-mapping/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}

export function updateRoleMapping(id: number, role: UserRole): Promise<OidcRoleMapping> {
  return request<OidcRoleMapping>(`/api/admin/role-mapping/groups/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  })
}

export function deleteRoleMapping(id: number): Promise<void> {
  return request<void>(`/api/admin/role-mapping/groups/${id}`, { method: "DELETE" })
}
