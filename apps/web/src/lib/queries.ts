import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  fetchProject,
  fetchProjects,
  regenerateThumbnail,
  restoreProjectVersion,
  uploadProjectVersion,
} from "./api"

const REFETCH_INTERVAL_MS = 10_000

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
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

export function useUploadVersion(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ files, message }: { files: File[]; message: string }) =>
      uploadProjectVersion(id, files, message),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects", id] })
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}

export function useRestoreVersion(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sha: string) => restoreProjectVersion(id, sha),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects", id] })
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}

export function useRegenerateThumbnail(id: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => regenerateThumbnail(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects", id] })
      void queryClient.invalidateQueries({ queryKey: ["projects"] })
    },
  })
}
