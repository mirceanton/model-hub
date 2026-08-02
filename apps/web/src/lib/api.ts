import type { Project, ProjectDetail } from "@model-hub/shared"

async function request<T>(path: string): Promise<T> {
  const res = await fetch(path)
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
