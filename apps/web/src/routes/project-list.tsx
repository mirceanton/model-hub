import type { Project } from "@model-hub/shared"
import { AlertCircle, FolderOpen, Search } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router"
import { ProjectThumbnail } from "@/components/project-thumbnail"
import { SyncStatusBadge } from "@/components/sync-status-badge"
import { TagPanel } from "@/components/tag-panel"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDateTime } from "@/lib/format"
import { useProjects, useTags } from "@/lib/queries"
import { tagBadgeStyle } from "@/lib/tag-colors"

const SEARCH_DEBOUNCE_MS = 250

export function ProjectListPage() {
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [activeTag, setActiveTag] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  const { data: tags, isPending: tagsPending } = useTags()
  const {
    data: projects,
    isPending,
    isError,
    error,
  } = useProjects({ q: search || undefined, tag: activeTag ?? undefined })

  const isFiltered = search.trim().length > 0 || activeTag != null

  return (
    <div className="grid grid-cols-1 gap-y-4 [grid-template-areas:'search'_'tags'_'content'] lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-x-6 lg:[grid-template-areas:'search_tags'_'content_tags']">
      <div className="relative w-full [grid-area:search] sm:max-w-xs">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search by title…"
          className="pl-8"
        />
      </div>

      <div className="min-w-0 [grid-area:content]">
        {isPending ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/5] w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Couldn't load your library</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-24 text-center text-muted-foreground">
            <FolderOpen className="size-8" />
            <p className="font-medium text-foreground">
              {isFiltered ? "No projects match" : "No projects yet"}
            </p>
            <p className="text-sm">
              {isFiltered
                ? "Try a different search or tag."
                : "Drop a folder into your library directory to get started."}
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

      <TagPanel
        tags={tags}
        isLoading={tagsPending}
        activeTag={activeTag}
        onSelectTag={setActiveTag}
        className="[grid-area:tags]"
      />
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
          {project.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {project.tags.map((tag) => (
                <Badge
                  key={tag.id}
                  variant="outline"
                  className="text-[10px]"
                  style={tagBadgeStyle(tag.color)}
                >
                  {tag.name}
                </Badge>
              ))}
            </div>
          )}
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
