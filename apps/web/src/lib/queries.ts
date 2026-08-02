import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  addProjectTag,
  fetchProject,
  fetchProjects,
  fetchTags,
  regenerateThumbnail,
  removeProjectTag,
  restoreProjectVersion,
  uploadProjectVersion,
  type ProjectFilters,
} from "./api"

const REFETCH_INTERVAL_MS = 10_000

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
