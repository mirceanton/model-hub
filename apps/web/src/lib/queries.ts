import { useQuery } from "@tanstack/react-query"
import { fetchProject, fetchProjects } from "./api"

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
