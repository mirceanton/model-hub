import type { Project } from "@model-hub/shared"
import { AlertCircle, Layers, Search } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router"
import { CreateProjectDialog } from "@/components/create-project-dialog"
import { ProjectThumbnail } from "@/components/project-thumbnail-mosaic"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDateTime } from "@/lib/format"
import { useProjects } from "@/lib/queries"

const SEARCH_DEBOUNCE_MS = 250

export function ProjectListPage() {
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  const { data: projects, isPending, isError, error } = useProjects({ q: search || undefined })
  const isFiltered = search.trim().length > 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search projects…"
            className="pl-8"
          />
        </div>
        <CreateProjectDialog />
      </div>

      {isPending ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[4/5] w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Couldn't load your projects</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-24 text-center text-muted-foreground">
          <Layers className="size-8" />
          <p className="font-medium text-foreground">
            {isFiltered ? "No projects match" : "No projects yet"}
          </p>
          <p className="text-sm">
            {isFiltered
              ? "Try a different search."
              : "Bundle a set of models pinned to specific commits into a project."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
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
          <CardTitle className="line-clamp-1 text-sm">{project.title}</CardTitle>
          <p className="line-clamp-1 text-xs text-muted-foreground">
            {project.pinCount === 0
              ? "No models pinned"
              : `${project.pinCount} model${project.pinCount === 1 ? "" : "s"} pinned`}
          </p>
          <p className="text-xs text-muted-foreground/70">Updated {formatDateTime(project.updatedAt)}</p>
        </CardContent>
      </Card>
    </Link>
  )
}
