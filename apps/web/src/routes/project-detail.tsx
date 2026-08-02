import type { GitLogEntry } from "@model-hub/shared"
import {
  AlertCircle,
  ArrowLeft,
  File,
  GitCommitHorizontal,
  History,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react"
import { lazy, Suspense, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { ProjectThumbnail } from "@/components/project-thumbnail"
import { SyncStatusBadge } from "@/components/sync-status-badge"
import { TagEditor } from "@/components/tag-editor"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { UploadVersionDialog } from "@/components/upload-version-dialog"
import { formatBytes, formatDateTime } from "@/lib/format"
import { fileUrl, isViewableExtension } from "@/lib/model-loader"
import {
  useForgetProject,
  useProject,
  useRegenerateThumbnail,
  useRestoreVersion,
  useUpdateProject,
} from "@/lib/queries"
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

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <EditableTitle projectId={project.id} title={project.title} />
            <SyncStatusBadge status={project.syncStatus} />
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">{project.path}</p>
          <TagEditor projectId={project.id} tags={project.tags} />
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
          {project.syncStatus === "missing" && <ForgetProjectButton projectId={project.id} />}
          <RegenerateThumbnailButton projectId={project.id} className="flex-1 sm:flex-none" />
          <UploadVersionDialog projectId={project.id} className="flex-1 sm:flex-none" />
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

      <EditableDescription projectId={project.id} description={project.description} />
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
            is kept in case it reappears, or you can forget it below.
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

function EditableTitle({ projectId, title }: { projectId: number; title: string }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const update = useUpdateProject(projectId)

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(title)
          setEditing(true)
        }}
        className="rounded text-left text-xl font-semibold hover:bg-muted/50"
        title="Click to rename"
      >
        {title}
      </button>
    )
  }

  function commit() {
    setEditing(false)
    const trimmed = value.trim()
    if (trimmed && trimmed !== title) {
      update.mutate({ title: trimmed })
    }
  }

  return (
    <Input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit()
        if (e.key === "Escape") {
          setValue(title)
          setEditing(false)
        }
      }}
      className="h-8 max-w-sm text-xl font-semibold"
    />
  )
}

function EditableDescription({
  projectId,
  description,
}: {
  projectId: number
  description: string
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(description)
  const update = useUpdateProject(projectId)

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(description)
          setEditing(true)
        }}
        className="rounded px-1 py-0.5 text-left text-sm text-muted-foreground hover:bg-muted/50"
        title="Click to edit"
      >
        {description || "No description yet. Click to add one."}
      </button>
    )
  }

  function commit() {
    setEditing(false)
    if (value !== description) {
      update.mutate({ description: value })
    }
  }

  return (
    <Textarea
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setValue(description)
          setEditing(false)
        }
      }}
      placeholder="What is this project?"
      rows={3}
    />
  )
}

function ForgetProjectButton({ projectId }: { projectId: number }) {
  const forget = useForgetProject(projectId)
  const navigate = useNavigate()

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={forget.isPending}
      onClick={() => {
        if (
          !confirm(
            "Forget this project? This only removes its tags/description/history from model-hub — it never touches disk, and the directory is already gone.",
          )
        ) {
          return
        }
        forget.mutate(undefined, { onSuccess: () => navigate("/") })
      }}
    >
      {forget.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
      Forget
    </Button>
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

function RegenerateThumbnailButton({
  projectId,
  className,
}: {
  projectId: number
  className?: string
}) {
  const regenerate = useRegenerateThumbnail(projectId)

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={regenerate.isPending}
      onClick={() => regenerate.mutate()}
      title="Regenerate thumbnail"
      className={className}
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
