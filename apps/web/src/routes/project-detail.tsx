import type { GitLogEntry } from "@model-hub/shared"
import {
  AlertCircle,
  ArrowLeft,
  File,
  GitCommitHorizontal,
  History,
  Loader2,
  RefreshCw,
} from "lucide-react"
import { lazy, Suspense, useState } from "react"
import { Link, useParams } from "react-router"
import { ProjectThumbnail } from "@/components/project-thumbnail"
import { SyncStatusBadge } from "@/components/sync-status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { UploadVersionDialog } from "@/components/upload-version-dialog"
import { formatBytes, formatDateTime } from "@/lib/format"
import { fileUrl, isViewableExtension } from "@/lib/model-loader"
import { useProject, useRegenerateThumbnail, useRestoreVersion } from "@/lib/queries"
import { cn } from "@/lib/utils"

const ModelViewer = lazy(() =>
  import("@/components/model-viewer").then((m) => ({ default: m.ModelViewer })),
)

export function ProjectDetailPage() {
  const params = useParams<{ id: string }>()
  const id = Number(params.id)
  const { data: project, isPending, isError, error } = useProject(id)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  if (isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-80 w-full" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Couldn't load this project</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    )
  }

  const activePath = selectedPath ?? project.primaryFilePath
  const activeFile = project.files.find((f) => f.relativePath === activePath)
  const viewerHeight = "h-80 w-full sm:h-[28rem]"

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold">{project.title}</h1>
            <SyncStatusBadge status={project.syncStatus} />
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">{project.path}</p>
        </div>
        <div className="flex items-center gap-2">
          <RegenerateThumbnailButton projectId={project.id} />
          <UploadVersionDialog projectId={project.id} />
        </div>
      </div>

      {activeFile && isViewableExtension(activeFile.extension) ? (
        <Suspense fallback={<Skeleton className={viewerHeight} />}>
          <ModelViewer
            key={activeFile.relativePath}
            url={fileUrl(project.id, activeFile.relativePath)}
            extension={activeFile.extension}
            className={viewerHeight}
          />
        </Suspense>
      ) : (
        <ProjectThumbnail project={project} className={viewerHeight} />
      )}

      <p className="text-sm text-muted-foreground">
        {project.description || "No description yet."}
      </p>
      {project.lastSyncedAt && (
        <p className="-mt-4 text-xs text-muted-foreground/70">
          Last synced {formatDateTime(project.lastSyncedAt)}
        </p>
      )}

      {project.syncStatus === "error" && project.syncError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Sync error</AlertTitle>
          <AlertDescription>{project.syncError}</AlertDescription>
        </Alert>
      )}

      {project.syncStatus === "missing" && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Directory missing</AlertTitle>
          <AlertDescription>
            This project's directory could not be found on the last library scan. Its metadata
            is kept in case it reappears.
          </AlertDescription>
        </Alert>
      )}

      <Separator />

      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">Files ({project.files.length})</TabsTrigger>
          <TabsTrigger value="history">History ({project.gitLog.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="files" className="mt-4">
          {project.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">No model files in this project yet.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {project.files.map((file) => (
                <li key={file.relativePath}>
                  <button
                    type="button"
                    onClick={() => setSelectedPath(file.relativePath)}
                    disabled={!isViewableExtension(file.extension)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent",
                      file.relativePath === activePath && "bg-muted/70",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <File className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm">
                        {file.relativePath}
                        {file.relativePath === project.primaryFilePath && (
                          <Badge variant="outline" className="ml-2">
                            primary
                          </Badge>
                        )}
                      </span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatBytes(file.sizeBytes)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          {project.gitLog.length === 0 ? (
            <p className="text-sm text-muted-foreground">No commit history yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {project.gitLog.map((entry, index) => (
                <li key={entry.sha} className="flex items-start gap-3 rounded-lg border px-3 py-2">
                  <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm">{entry.message}</span>
                    <span className="text-xs text-muted-foreground">
                      {entry.authorName} · {formatDateTime(entry.date)} ·{" "}
                      <span className="font-mono">{entry.sha.slice(0, 10)}</span>
                    </span>
                  </div>
                  {index > 0 && <RestoreButton projectId={project.id} entry={entry} />}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function RestoreButton({ projectId, entry }: { projectId: number; entry: GitLogEntry }) {
  const restore = useRestoreVersion(projectId)

  return (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0"
      disabled={restore.isPending}
      onClick={() => {
        if (!confirm(`Restore file contents from "${entry.message}"? This creates a new commit.`)) {
          return
        }
        restore.mutate(entry.sha)
      }}
    >
      {restore.isPending ? <Loader2 className="size-4 animate-spin" /> : <History className="size-4" />}
      Restore
    </Button>
  )
}

function RegenerateThumbnailButton({ projectId }: { projectId: number }) {
  const regenerate = useRegenerateThumbnail(projectId)

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={regenerate.isPending}
      onClick={() => regenerate.mutate()}
      title="Regenerate thumbnail"
    >
      <RefreshCw className={cn("size-4", regenerate.isPending && "animate-spin")} />
      Thumbnail
    </Button>
  )
}

function BackLink() {
  return (
    <Link
      to="/"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Back to library
    </Link>
  )
}
