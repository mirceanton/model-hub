import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  addProjectTag,
  createTag,
  deleteTag,
  fetchAuthMe,
  fetchProject,
  fetchProjects,
  fetchTags,
  forgetProject,
  logout,
  regenerateThumbnail,
  removeProjectTag,
  restoreProjectVersion,
  updateProject,
  updateTag,
  uploadProjectVersion,
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
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}

export function useDeleteTag() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => deleteTag(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tags"] })
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}

function useInvalidateProject(id: number) {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["projects", id] })
    void queryClient.invalidateQueries({ queryKey: ["projects"] })
    void queryClient.invalidateQueries({ queryKey: ["tags"] })
  }
}

export function useUploadVersion(id: number) {
  const invalidate = useInvalidateProject(id)
  return useMutation({
    mutationFn: ({ files, message }: { files: File[]; message: string }) =>
      uploadProjectVersion(id, files, message),
    onSuccess: invalidate,
  })
}

export function useRestoreVersion(id: number) {
  const invalidate = useInvalidateProject(id)
  return useMutation({
    mutationFn: (sha: string) => restoreProjectVersion(id, sha),
    onSuccess: invalidate,
  })
}

export function useRegenerateThumbnail(id: number) {
  const invalidate = useInvalidateProject(id)
  return useMutation({
    mutationFn: () => regenerateThumbnail(id),
    onSuccess: invalidate,
  })
}

export function useAddTag(id: number) {
  const invalidate = useInvalidateProject(id)
  return useMutation({
    mutationFn: (name: string) => addProjectTag(id, name),
    onSuccess: invalidate,
  })
}

export function useRemoveTag(id: number) {
  const invalidate = useInvalidateProject(id)
  return useMutation({
    mutationFn: (tagId: number) => removeProjectTag(id, tagId),
    onSuccess: invalidate,
  })
}

export function useUpdateProject(id: number) {
  const invalidate = useInvalidateProject(id)
  return useMutation({
    mutationFn: (patch: { title?: string; description?: string }) => updateProject(id, patch),
    onSuccess: invalidate,
  })
}

export function useForgetProject(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => forgetProject(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}
