import type { Project } from "@model-hub/shared"
import { AlertCircle, FolderOpen } from "lucide-react"
import { Link } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ProjectThumbnail } from "@/components/project-thumbnail"
import { SyncStatusBadge } from "@/components/sync-status-badge"
import { formatDateTime } from "@/lib/format"
import { useProjects } from "@/lib/queries"

export function ProjectListPage() {
  const { data: projects, isPending, isError, error } = useProjects()

  if (isPending) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="aspect-[4/5] w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Couldn't load your library</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-24 text-center text-muted-foreground">
        <FolderOpen className="size-8" />
        <p className="font-medium text-foreground">No projects yet</p>
        <p className="text-sm">Drop a folder into your library directory to get started.</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </div>
  )
}

function ProjectCard({ project }: { project: Project }) {
  return (
    <Link to={`/projects/${project.id}`}>
      <Card className="h-full gap-3 py-3 transition-colors hover:border-foreground/20">
        <CardHeader className="px-3">
          <ProjectThumbnail project={project} />
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 px-3">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="line-clamp-1 text-sm">{project.title}</CardTitle>
            <SyncStatusBadge status={project.syncStatus} />
          </div>
          <p className="line-clamp-1 text-xs text-muted-foreground">
            {project.primaryFilePath ?? "No model files"}
          </p>
          {project.lastSyncedAt && (
            <p className="text-xs text-muted-foreground/70">
              Synced {formatDateTime(project.lastSyncedAt)}
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  )
}
