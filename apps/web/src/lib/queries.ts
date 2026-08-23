import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  addModelTag,
  addProjectPin,
  createModel,
  createProject,
  createTag,
  deleteModel,
  deleteModelFile,
  deleteProject,
  deleteTag,
  fetchAuthMe,
  fetchModel,
  fetchModels,
  fetchProject,
  fetchProjects,
  fetchTags,
  logout,
  regenerateThumbnail,
  removeModelTag,
  removeProjectPin,
  restoreModelVersion,
  updateModel,
  updateProject,
  updateProjectPin,
  updateTag,
  uploadModelVersion,
  type ModelFilters,
  type ProjectFilters,
} from "./api"

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
    mutationFn: (patch: { title?: string; description?: string; favorite?: boolean; primaryFilePath?: string }) =>
      updateModel(id, patch),
    onSuccess: invalidate,
  })
}

export function useCreateModel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { title: string; tags: string[]; files: File[] }) => createModel(input),
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
    },
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
