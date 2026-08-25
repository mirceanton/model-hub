import type { ProjectPinsBulkAction, UserRole } from "@model-hub/shared"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  addModelTag,
  addProjectPin,
  bulkDeleteModelFiles,
  bulkDeleteProjects,
  bulkModelsAction,
  bulkProjectPinsAction,
  captureThumbnail,
  createApiToken,
  createModel,
  createProject,
  createRoleMapping,
  createTag,
  deleteModel,
  deleteModelFile,
  deleteProject,
  deleteProjectThumbnail,
  deleteRoleMapping,
  deleteTag,
  dismissProjectNotice,
  exportModels,
  fetchAdminUsers,
  fetchApiTokens,
  fetchAuthMe,
  fetchInstanceStats,
  fetchModel,
  fetchModelDiff,
  fetchModels,
  fetchProject,
  fetchProjects,
  fetchRoleMapping,
  fetchTags,
  fetchTrash,
  logout,
  purgeFromTrash,
  refreshSourceSnapshot,
  regenerateThumbnail,
  removeModelTag,
  removeProjectPin,
  restoreFromTrash,
  restoreModelVersion,
  revokeApiToken,
  updateModel,
  updateProject,
  updateProjectPin,
  updateRoleMapping,
  updateRoleMappingSettings,
  updateTag,
  uploadModelVersion,
  uploadProjectThumbnail,
  type ModelFilters,
  type ModelsBulkInput,
  type ProjectFilters,
} from "./api"
import { triggerBlobDownload } from "./model-loader"

const REFETCH_INTERVAL_MS = 10_000

export function useAuthMe() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: fetchAuthMe,
    retry: false,
  })
}

export function useLogout() {
  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      window.location.href = "/auth/login"
    },
  })
}

export function useModels(filters: ModelFilters = {}) {
  return useQuery({
    queryKey: ["models", filters],
    queryFn: () => fetchModels(filters),
    refetchInterval: REFETCH_INTERVAL_MS,
  })
}

export function useModel(id: number) {
  return useQuery({
    queryKey: ["models", id],
    queryFn: () => fetchModel(id),
    enabled: Number.isFinite(id),
    refetchInterval: REFETCH_INTERVAL_MS,
  })
}

/**
 * The file-list diff preview shown before a project pin bump is confirmed
 * (manual re-pin or "bump to latest") — see ProjectPinRow. Disabled until
 * both shas are known and differ, so opening the confirm step never fires a
 * request for a no-op bump.
 */
export function useModelDiff(modelId: number, from: string | undefined, to: string | undefined) {
  return useQuery({
    queryKey: ["models", modelId, "diff", from, to],
    queryFn: () => fetchModelDiff(modelId, from!, to!),
    enabled: Number.isFinite(modelId) && !!from && !!to && from !== to,
  })
}

export function useTags() {
  return useQuery({
    queryKey: ["tags"],
    queryFn: fetchTags,
    refetchInterval: REFETCH_INTERVAL_MS,
  })
}

export function useCreateTag() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => createTag(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tags"] })
    },
  })
}

export function useUpdateTag(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: { name?: string; color?: string }) => updateTag(id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tags"] })
      void queryClient.invalidateQueries({ queryKey: ["models"] })
    },
  })
}

export function useDeleteTag() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteTag(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tags"] })
      void queryClient.invalidateQueries({ queryKey: ["models"] })
    },
  })
}

function useInvalidateModel(id: number) {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["models", id] })
    void queryClient.invalidateQueries({ queryKey: ["models"] })
    void queryClient.invalidateQueries({ queryKey: ["tags"] })
  }
}

export function useUploadVersion(id: number) {
  const invalidate = useInvalidateModel(id)
  return useMutation({
    mutationFn: ({ files, message }: { files: File[]; message: string }) =>
      uploadModelVersion(id, files, message),
    onSuccess: invalidate,
  })
}

export function useDeleteModelFile(id: number) {
  const invalidate = useInvalidateModel(id)
  return useMutation({
    mutationFn: (relativePath: string) => deleteModelFile(id, relativePath),
    onSuccess: invalidate,
  })
}

export function useBulkDeleteModelFiles(id: number) {
  const invalidate = useInvalidateModel(id)
  return useMutation({
    mutationFn: (relativePaths: string[]) => bulkDeleteModelFiles(id, relativePaths),
    onSuccess: invalidate,
  })
}

export function useRestoreVersion(id: number) {
  const invalidate = useInvalidateModel(id)
  return useMutation({
    mutationFn: (sha: string) => restoreModelVersion(id, sha),
    onSuccess: invalidate,
  })
}

export function useRegenerateThumbnail(id: number) {
  const invalidate = useInvalidateModel(id)
  return useMutation({
    mutationFn: () => regenerateThumbnail(id),
    onSuccess: invalidate,
  })
}

export function useCaptureThumbnail(id: number) {
  const invalidate = useInvalidateModel(id)
  return useMutation({
    mutationFn: (image: Blob) => captureThumbnail(id, image),
    onSuccess: invalidate,
  })
}

export function useAddTag(id: number) {
  const invalidate = useInvalidateModel(id)
  return useMutation({
    mutationFn: (name: string) => addModelTag(id, name),
    onSuccess: invalidate,
  })
}

export function useRemoveTag(id: number) {
  const invalidate = useInvalidateModel(id)
  return useMutation({
    mutationFn: (tagId: number) => removeModelTag(id, tagId),
    onSuccess: invalidate,
  })
}

export function useUpdateModel(id: number) {
  const invalidate = useInvalidateModel(id)
  return useMutation({
    mutationFn: (patch: {
      title?: string
      description?: string
      favorite?: boolean
      primaryFilePath?: string
      sourceUrl?: string | null
    }) => updateModel(id, patch),
    onSuccess: invalidate,
  })
}

export function useRefreshSourceSnapshot(id: number) {
  const invalidate = useInvalidateModel(id)
  return useMutation({
    mutationFn: () => refreshSourceSnapshot(id),
    onSuccess: invalidate,
  })
}

export function useCreateModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { title: string; tags: string[]; files: File[]; sourceUrl?: string }) =>
      createModel(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["models"] })
      void queryClient.invalidateQueries({ queryKey: ["tags"] })
    },
  })
}

export function useDeleteModel(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => deleteModel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["models"] })
      void queryClient.invalidateQueries({ queryKey: ["tags"] })
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
      void queryClient.invalidateQueries({ queryKey: ["trash"] })
    },
  })
}

/**
 * Backs every bulk action on the library grid (delete/favorite/unfavorite/
 * add-tag/remove-tag — see ModelBulkAction) via the single POST
 * /api/models/bulk endpoint. Resolves with a BulkResponse even on partial
 * failure (only a network/validation-level problem rejects) — the caller
 * inspects `data.results` to report per-item failures, same as every other
 * bulk hook below.
 */
export function useBulkModelsAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ModelsBulkInput) => bulkModelsAction(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["models"] })
      void queryClient.invalidateQueries({ queryKey: ["tags"] })
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
      void queryClient.invalidateQueries({ queryKey: ["trash"] })
    },
  })
}

/**
 * Backs the "Export selected" bulk-selection action (POST /api/models/export
 * — issue #64), which unlike useBulkModelsAction above doesn't mutate
 * anything server-side: it streams a zip of the selected models' current
 * files plus a manifest.json metadata sidecar, which this hook saves as a
 * file download (triggerBlobDownload) rather than caching/returning it as
 * query data, so it doesn't invalidate any query on success.
 */
export function useExportModels() {
  return useMutation({
    mutationFn: async (ids: number[]) => {
      const blob = await exportModels(ids)
      triggerBlobDownload(blob, "models.zip")
    },
  })
}

export function useTrash() {
  return useQuery({
    queryKey: ["trash"],
    queryFn: fetchTrash,
    refetchInterval: REFETCH_INTERVAL_MS,
  })
}

function useInvalidateTrash() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["trash"] })
    void queryClient.invalidateQueries({ queryKey: ["models"] })
    void queryClient.invalidateQueries({ queryKey: ["tags"] })
  }
}

export function useRestoreFromTrash() {
  const invalidate = useInvalidateTrash()
  return useMutation({
    mutationFn: (id: number) => restoreFromTrash(id),
    onSuccess: invalidate,
  })
}

export function usePurgeFromTrash() {
  const invalidate = useInvalidateTrash()
  return useMutation({
    mutationFn: (id: number) => purgeFromTrash(id),
    onSuccess: invalidate,
  })
}

export function useProjects(filters: ProjectFilters = {}) {
  return useQuery({
    queryKey: ["projects", filters],
    queryFn: () => fetchProjects(filters),
    refetchInterval: REFETCH_INTERVAL_MS,
  })
}

export function useProject(id: number) {
  return useQuery({
    queryKey: ["projects", id],
    queryFn: () => fetchProject(id),
    enabled: Number.isFinite(id),
    refetchInterval: REFETCH_INTERVAL_MS,
  })
}

function useInvalidateProject(id: number) {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["projects", id] })
    void queryClient.invalidateQueries({ queryKey: ["projects"] })
  }
}

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { title: string; description?: string }) => createProject(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}

export function useUpdateProject(id: number) {
  const invalidate = useInvalidateProject(id)
  return useMutation({
    mutationFn: (patch: { title?: string; description?: string }) => updateProject(id, patch),
    onSuccess: invalidate,
  })
}

export function useDeleteProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteProject(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}

export function useBulkDeleteProjects() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (ids: number[]) => bulkDeleteProjects(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}

export function useAddPin(projectId: number) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation({
    mutationFn: (input: { modelId: number; commitSha?: string }) => addProjectPin(projectId, input),
    onSuccess: invalidate,
  })
}

export function useUpdatePin(projectId: number) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation({
    mutationFn: ({ modelId, commitSha }: { modelId: number; commitSha?: string }) =>
      updateProjectPin(projectId, modelId, commitSha),
    onSuccess: invalidate,
  })
}

export function useRemovePin(projectId: number) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation({
    mutationFn: (modelId: number) => removeProjectPin(projectId, modelId),
    onSuccess: invalidate,
  })
}

/** Backs the pinned-models bulk action bar in ProjectDetailPage — "remove" or "bump" (to each model's current commit) via one POST /api/projects/:id/pins/bulk call. */
export function useBulkProjectPinsAction(projectId: number) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation({
    mutationFn: ({ ids, action }: { ids: number[]; action: ProjectPinsBulkAction }) =>
      bulkProjectPinsAction(projectId, ids, action),
    onSuccess: invalidate,
  })
}

export function useDismissProjectNotice(projectId: number) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation({
    mutationFn: (noticeId: number) => dismissProjectNotice(projectId, noticeId),
    onSuccess: invalidate,
  })
}

export function useUploadProjectThumbnail(projectId: number) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation({
    mutationFn: (image: Blob) => uploadProjectThumbnail(projectId, image),
    onSuccess: invalidate,
  })
}

export function useDeleteProjectThumbnail(projectId: number) {
  const invalidate = useInvalidateProject(projectId)
  return useMutation({
    mutationFn: () => deleteProjectThumbnail(projectId),
    onSuccess: invalidate,
  })
}

export function useAdminUsers() {
  return useQuery({
    queryKey: ["admin", "users"],
    queryFn: fetchAdminUsers,
  })
}

export function useRoleMapping() {
  return useQuery({
    queryKey: ["admin", "role-mapping"],
    queryFn: fetchRoleMapping,
  })
}

/**
 * Deliberately no refetchInterval, unlike most other queries here: GET
 * /api/stats does a genuine recursive `stat` walk of the whole LIBRARY_ROOT
 * tree to compute storage usage (no cheaper data source exists for that
 * number — see apps/server/src/lib/disk-usage.ts), so polling it every
 * REFETCH_INTERVAL_MS would re-walk the entire library on disk every few
 * seconds for as long as an admin has the Stats page open. That's
 * especially costly over the NFS/SMB-mounted libraries this app explicitly
 * supports (see CLAUDE.md's sync engine notes on network-mount reliability/
 * cost). The Stats page instead exposes a manual refresh action; react-
 * query's refetch-on-window-focus default still keeps it reasonably fresh
 * without a timer.
 */
export function useInstanceStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: fetchInstanceStats,
  })
}

function useInvalidateRoleMapping() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "role-mapping"] })
  }
}

export function useUpdateRoleMappingSettings() {
  const invalidate = useInvalidateRoleMapping()
  return useMutation({
    mutationFn: (patch: { groupsClaim?: string; defaultRole?: UserRole }) =>
      updateRoleMappingSettings(patch),
    onSuccess: invalidate,
  })
}

export function useCreateRoleMapping() {
  const invalidate = useInvalidateRoleMapping()
  return useMutation({
    mutationFn: (input: { groupName: string; role: UserRole }) => createRoleMapping(input),
    onSuccess: invalidate,
  })
}

export function useUpdateRoleMapping() {
  const invalidate = useInvalidateRoleMapping()
  return useMutation({
    mutationFn: ({ id, role }: { id: number; role: UserRole }) => updateRoleMapping(id, role),
    onSuccess: invalidate,
  })
}

export function useDeleteRoleMapping() {
  const invalidate = useInvalidateRoleMapping()
  return useMutation({
    mutationFn: (id: number) => deleteRoleMapping(id),
    onSuccess: invalidate,
  })
}

export function useApiTokens() {
  return useQuery({
    queryKey: ["api-tokens"],
    queryFn: fetchApiTokens,
  })
}

export function useCreateApiToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { label: string; expiresAt?: number }) => createApiToken(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["api-tokens"] })
    },
  })
}

export function useRevokeApiToken() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => revokeApiToken(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["api-tokens"] })
    },
  })
}
