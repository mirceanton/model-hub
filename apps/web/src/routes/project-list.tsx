import type { BulkResponse, Project } from "@model-hub/shared"
import { AlertCircle, Layers, ListChecks, Loader2, Search, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router"
import { BulkActionBar, BulkFailureAlert } from "@/components/bulk-action-bar"
import { CreateProjectDialog } from "@/components/create-project-dialog"
import { ProjectThumbnail } from "@/components/project-thumbnail-mosaic"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useSelection } from "@/hooks/use-selection"
import { formatDateTime } from "@/lib/format"
import { useBulkDeleteProjects, useProjects } from "@/lib/queries"
import { cn } from "@/lib/utils"

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

  const selection = useSelection<number>()
  const bulkDelete = useBulkDeleteProjects()
  const [bulkResult, setBulkResult] = useState<BulkResponse | undefined>()

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
        <div className="flex items-center gap-2">
          {projects && projects.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={selection.active}
              onClick={() => {
                setBulkResult(undefined)
                selection.setActive(!selection.active)
              }}
              className={cn(selection.active && "border-primary/50 bg-primary/10 text-primary")}
            >
              <ListChecks className="size-3.5" />
              Select
            </Button>
          )}
          <CreateProjectDialog />
        </div>
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
        <>
          {selection.active && (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={projects.every((p) => selection.isSelected(p.id))}
                  indeterminate={
                    selection.selected.size > 0 && !projects.every((p) => selection.isSelected(p.id))
                  }
                  onCheckedChange={(checked) =>
                    checked ? selection.selectAll(projects.map((p) => p.id)) : selection.clear()
                  }
                />
                Select all
              </label>
              {selection.selected.size > 0 && (
                <BulkActionBar count={selection.selected.size} onClear={selection.clear}>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={bulkDelete.isPending}
                    onClick={() => {
                      const count = selection.selected.size
                      if (!confirm(`Delete ${count} project${count === 1 ? "" : "s"}? Models themselves are untouched.`)) {
                        return
                      }
                      bulkDelete.mutate([...selection.selected], {
                        onSuccess: (data) => {
                          setBulkResult(data)
                          selection.clear()
                        },
                      })
                    }}
                  >
                    {bulkDelete.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    Delete
                  </Button>
                </BulkActionBar>
              )}
              <BulkFailureAlert
                response={bulkResult}
                labelFor={(id) => projects.find((p) => p.id === id)?.title ?? `Project #${id}`}
              />
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                selectable={selection.active}
                selected={selection.isSelected(project.id)}
                onToggleSelect={() => selection.toggle(project.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ProjectCard({
  project,
  selectable,
  selected,
  onToggleSelect,
}: {
  project: Project
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  return (
    <Link
      to={`/projects/${project.id}`}
      onClick={(e) => {
        if (!selectable) return
        e.preventDefault()
        onToggleSelect?.()
      }}
    >
      <Card
        className={cn(
          "h-full gap-3 py-3 transition-colors hover:border-foreground/20",
          selected && "border-primary ring-2 ring-primary/30",
        )}
      >
        <CardHeader className="relative px-3">
          <ProjectThumbnail project={project} />
          {selectable && (
            <Checkbox
              checked={!!selected}
              onCheckedChange={() => onToggleSelect?.()}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${project.title}`}
              className="absolute top-2 left-2 bg-background/80 backdrop-blur-sm"
            />
          )}
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
