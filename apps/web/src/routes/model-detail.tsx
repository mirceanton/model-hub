import type { GitLogEntry, SourceSnapshotStatus } from "@model-hub/shared"
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  Copy,
  Download,
  ExternalLink,
  File,
  GitCommitHorizontal,
  Globe,
  History,
  Loader2,
  Pencil,
  RefreshCw,
  Star,
  Trash2,
} from "lucide-react"
import { lazy, Suspense, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { DuplicateBadge } from "@/components/duplicate-badge"
import { FavoriteToggle } from "@/components/favorite-toggle"
import { MarkdownContent } from "@/components/markdown-content"
import { ModelAttachments } from "@/components/model-attachments"
import { ModelThumbnail } from "@/components/model-thumbnail"
import { SyncStatusBadge } from "@/components/sync-status-badge"
import { TagEditor } from "@/components/tag-editor"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { UploadVersionDialog } from "@/components/upload-version-dialog"
import { formatBytes, formatDateTime } from "@/lib/format"
import { archiveUrl, fileUrl, isViewableExtension } from "@/lib/model-loader"
import {
  useCaptureThumbnail,
  useDeleteModel,
  useDeleteModelFile,
  useModel,
  useRefreshSourceSnapshot,
  useRegenerateThumbnail,
  useRestoreVersion,
  useUpdateModel,
} from "@/lib/queries"
import { cn } from "@/lib/utils"

const ModelViewer = lazy(() =>
  import("@/components/model-viewer").then((m) => ({ default: m.ModelViewer })),
)

export function ModelDetailPage() {
  const params = useParams<{ id: string }>()
  const id = Number(params.id)
  const { data: model, isPending, isError, error } = useModel(id)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [viewerCanvas, setViewerCanvas] = useState<HTMLCanvasElement | null>(null)

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
          <AlertTitle>Couldn't load this model</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    )
  }

  const activePath = selectedPath ?? model.primaryFilePath
  const activeFile = model.files.find((f) => f.relativePath === activePath)
  const viewableExtension =
    activeFile && isViewableExtension(activeFile.extension) ? activeFile.extension : null
  const isViewable = viewableExtension != null
  const viewerHeight = "h-80 w-full sm:h-[28rem]"

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <EditableTitle modelId={model.id} title={model.title} />
            <SyncStatusBadge status={model.syncStatus} />
            <DuplicateBadge duplicates={model.duplicateModels} />
            <ModelFavoriteToggle modelId={model.id} favorite={model.favorite} />
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">{model.path}</p>
          <ModelSource
            modelId={model.id}
            sourceUrl={model.sourceUrl}
            snapshotStatus={model.sourceSnapshotStatus}
            snapshotError={model.sourceSnapshotError}
            snapshotHtml={model.sourceSnapshotHtml}
          />
          <TagEditor modelId={model.id} tags={model.tags} />
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
          <DeleteModelButton modelId={model.id} />
          {isViewable && (
            <CaptureThumbnailButton
              modelId={model.id}
              canvas={viewerCanvas}
              className="flex-1 sm:flex-none"
            />
          )}
          <RegenerateThumbnailButton modelId={model.id} className="flex-1 sm:flex-none" />
          <DownloadModelButton
            modelId={model.id}
            disabled={model.files.length === 0 && model.attachments.length === 0}
            className="flex-1 sm:flex-none"
          />
          <UploadVersionDialog modelId={model.id} className="flex-1 sm:flex-none" />
        </div>
      </div>

      {activeFile && viewableExtension ? (
        <Suspense fallback={<Skeleton className={viewerHeight} />}>
          <ModelViewer
            key={activeFile.relativePath}
            url={fileUrl(model.id, activeFile.relativePath)}
            extension={viewableExtension}
            className={viewerHeight}
            onCanvasReady={setViewerCanvas}
          />
        </Suspense>
      ) : (
        <ModelThumbnail model={model} className={viewerHeight} />
      )}
      {model.thumbnailSource === "manual" && (
        <p className="-mt-4 flex items-center gap-1.5 text-xs text-muted-foreground/70">
          <Badge variant="outline">Custom thumbnail</Badge>
          Won't be replaced by future syncs — use "Thumbnail" above to go back to automatic.
        </p>
      )}

      <EditableDescription modelId={model.id} description={model.description} />
      {model.lastSyncedAt && (
        <p className="-mt-4 text-xs text-muted-foreground/70">
          Last synced {formatDateTime(model.lastSyncedAt)}
        </p>
      )}

      {model.duplicateModels.length > 0 && (
        <Alert className="border-amber-400/50 bg-amber-400/10 text-amber-700 dark:text-amber-400">
          <Copy />
          <AlertTitle>Possible duplicate</AlertTitle>
          <AlertDescription className="text-amber-700/80 dark:text-amber-400/80">
            This model shares a file with{" "}
            {model.duplicateModels.map((dup, index) => (
              <span key={dup.modelId}>
                {index > 0 && ", "}
                <Link to={`/models/${dup.modelId}`}>{dup.modelTitle}</Link>
              </span>
            ))}
            .
          </AlertDescription>
        </Alert>
      )}

      {model.syncStatus === "error" && model.syncError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Sync error</AlertTitle>
          <AlertDescription>{model.syncError}</AlertDescription>
        </Alert>
      )}

      {model.syncStatus === "missing" && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Directory missing</AlertTitle>
          <AlertDescription>
            This model's directory could not be found on the last library scan. Its metadata
            is kept in case it reappears, or you can delete it above.
          </AlertDescription>
        </Alert>
      )}

      <Separator />

      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">Files ({model.files.length})</TabsTrigger>
          <TabsTrigger value="attachments">Attachments ({model.attachments.length})</TabsTrigger>
          <TabsTrigger value="history">History ({model.gitLog.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="files" className="mt-4">
          {model.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">No model files in this model yet.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {model.files.map((file) => (
                <li
                  key={file.relativePath}
                  className={cn(
                    "flex items-center gap-1 pr-2 transition-colors hover:bg-muted/50",
                    file.relativePath === activePath && "bg-muted/70",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedPath(file.relativePath)}
                    disabled={!isViewableExtension(file.extension)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left disabled:cursor-default"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <File className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate text-sm">{file.relativePath}</span>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatBytes(file.sizeBytes)}
                    </span>
                  </button>
                  <SetPrimaryFileButton
                    modelId={model.id}
                    isPrimary={file.relativePath === model.primaryFilePath}
                    relativePath={file.relativePath}
                  />
                  <DownloadFileButton modelId={model.id} relativePath={file.relativePath} />
                  <DeleteFileButton modelId={model.id} relativePath={file.relativePath} />
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="attachments" className="mt-4">
          <ModelAttachments modelId={model.id} attachments={model.attachments} />
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          {model.gitLog.length === 0 ? (
            <p className="text-sm text-muted-foreground">No commit history yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {model.gitLog.map((entry, index) => (
                <li key={entry.sha} className="flex items-start gap-3 rounded-lg border px-3 py-2">
                  <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm">{entry.message}</span>
                    <span className="text-xs text-muted-foreground">
                      {entry.authorName} · {formatDateTime(entry.date)} ·{" "}
                      <span className="font-mono">{entry.sha.slice(0, 10)}</span>
                    </span>
                  </div>
                  {index > 0 && <RestoreButton modelId={model.id} entry={entry} />}
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ModelSource({
  modelId,
  sourceUrl,
  snapshotStatus,
  snapshotError,
  snapshotHtml,
}: {
  modelId: number
  sourceUrl: string | null
  snapshotStatus: SourceSnapshotStatus
  snapshotError: string | null
  snapshotHtml: string | null
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(sourceUrl ?? "")
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const update = useUpdateModel(modelId)
  const refresh = useRefreshSourceSnapshot(modelId)

  function startEditing() {
    setValue(sourceUrl ?? "")
    setEditing(true)
  }

  function commit() {
    setEditing(false)
    const trimmed = value.trim()
    if (trimmed !== (sourceUrl ?? "")) {
      update.mutate({ sourceUrl: trimmed || null })
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <Globe className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          autoFocus
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            if (e.key === "Escape") {
              setValue(sourceUrl ?? "")
              setEditing(false)
            }
          }}
          placeholder="https://www.printables.com/model/…"
          className="h-7 max-w-sm text-xs"
        />
      </div>
    )
  }

  if (!sourceUrl) {
    return (
      <button
        type="button"
        onClick={startEditing}
        className="flex w-fit items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground hover:bg-muted/50"
        title="Click to add a source URL"
      >
        <Globe className="size-3.5" />
        Add source URL
      </button>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Globe className="size-3.5 shrink-0 text-muted-foreground" />
      <a
        href={sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={sourceUrl}
        className="inline-flex max-w-xs items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        <span className="truncate">{sourceUrl}</span>
        <ExternalLink className="size-3 shrink-0" />
      </a>
      <button
        type="button"
        onClick={startEditing}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted/50"
        aria-label="Edit source URL"
        title="Edit source URL"
      >
        <Pencil className="size-3" />
      </button>

      {snapshotStatus === "pending" && (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Snapshotting…
        </Badge>
      )}
      {snapshotStatus === "error" && (
        <Badge
          variant="outline"
          className="gap-1 border-destructive/50 text-destructive"
          title={snapshotError ?? "Snapshot fetch failed"}
        >
          <AlertCircle className="size-3" />
          Snapshot unavailable
        </Badge>
      )}
      {snapshotStatus === "ready" && snapshotHtml && (
        <Dialog open={snapshotOpen} onOpenChange={setSnapshotOpen}>
          <DialogTrigger render={<Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" />}>
            View saved snapshot
          </DialogTrigger>
          <DialogContent className="max-w-3xl sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Saved snapshot</DialogTitle>
              <DialogDescription>
                A sanitized copy of the source page from the last fetch — in case the live link ever
                goes dead. Rendered in a sandboxed frame with scripts disabled.
              </DialogDescription>
            </DialogHeader>
            <iframe
              title="Saved source snapshot"
              srcDoc={snapshotHtml}
              // No `allow-scripts` (or anything else) — this is the
              // defense-in-depth layer on top of server-side sanitization:
              // even a sanitizer gap can't execute script here.
              sandbox=""
              referrerPolicy="no-referrer"
              className="h-[60vh] w-full rounded-md border bg-white"
            />
          </DialogContent>
        </Dialog>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-6"
        disabled={refresh.isPending}
        onClick={() => refresh.mutate()}
        title="Refresh saved snapshot"
        aria-label="Refresh saved snapshot"
      >
        <RefreshCw className={cn("size-3", refresh.isPending && "animate-spin")} />
      </Button>
    </div>
  )
}

function ModelFavoriteToggle({ modelId, favorite }: { modelId: number; favorite: boolean }) {
  const update = useUpdateModel(modelId)
  return (
    <FavoriteToggle favorite={favorite} onToggle={() => update.mutate({ favorite: !favorite })} />
  )
}

function SetPrimaryFileButton({
  modelId,
  isPrimary,
  relativePath,
}: {
  modelId: number
  isPrimary: boolean
  relativePath: string
}) {
  const update = useUpdateModel(modelId)

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      disabled={isPrimary || update.isPending}
      aria-label={isPrimary ? "Primary file for thumbnails" : "Set as primary file for thumbnails"}
      aria-pressed={isPrimary}
      title={isPrimary ? "Primary file for thumbnails" : "Set as primary file for thumbnails"}
      onClick={(e) => {
        e.stopPropagation()
        update.mutate({ primaryFilePath: relativePath })
      }}
    >
      <Star className={cn("size-4", isPrimary && "fill-amber-400 text-amber-400")} />
    </Button>
  )
}

function DownloadModelButton({
  modelId,
  disabled,
  className,
}: {
  modelId: number
  disabled?: boolean
  className?: string
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      title="Download all files as a zip archive"
      className={className}
      nativeButton={false}
      render={<a href={archiveUrl(modelId)} download />}
    >
      <Download className="size-4" />
      Download
    </Button>
  )
}

function DownloadFileButton({ modelId, relativePath }: { modelId: number; relativePath: string }) {
  const fileName = relativePath.split("/").pop()

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 text-muted-foreground"
      title={`Download ${relativePath}`}
      nativeButton={false}
      render={<a href={fileUrl(modelId, relativePath)} download={fileName} onClick={(e) => e.stopPropagation()} />}
    >
      <Download className="size-4" />
    </Button>
  )
}

function EditableTitle({ modelId, title }: { modelId: number; title: string }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const update = useUpdateModel(modelId)

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
  modelId,
  description,
}: {
  modelId: number
  description: string
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(description)
  const update = useUpdateModel(modelId)

  if (!editing) {
    function startEditing() {
      setValue(description)
      setEditing(true)
    }

    return (
      <div className="group flex items-start justify-between gap-2">
        {description ? (
          <MarkdownContent content={description} className="min-w-0 flex-1" />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className="rounded px-1 py-0.5 text-left text-sm text-muted-foreground hover:bg-muted/50"
            title="Click to edit"
          >
            No description yet. Click to add one.
          </button>
        )}
        {description && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 opacity-0 group-hover:opacity-100"
            onClick={startEditing}
            aria-label="Edit description"
            title="Edit description"
          >
            <Pencil className="size-4" />
          </Button>
        )}
      </div>
    )
  }

  function commit() {
    setEditing(false)
    if (value !== description) {
      update.mutate({ description: value })
    }
  }

  return (
    <div className="flex flex-col gap-1">
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
        placeholder="What is this model? Markdown is supported."
        rows={3}
      />
      <p className="text-xs text-muted-foreground/70">Markdown supported.</p>
    </div>
  )
}

function DeleteModelButton({ modelId }: { modelId: number }) {
  const deleteModel = useDeleteModel(modelId)
  const navigate = useNavigate()

  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      disabled={deleteModel.isPending}
      onClick={() => {
        if (
          !confirm(
            "Move this model to trash? It's kept for 7 days (restorable from the Trash view) before being permanently removed.",
          )
        ) {
          return
        }
        deleteModel.mutate(undefined, { onSuccess: () => navigate("/") })
      }}
    >
      {deleteModel.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Trash2 className="size-4" />
      )}
      Delete
    </Button>
  )
}

function DeleteFileButton({ modelId, relativePath }: { modelId: number; relativePath: string }) {
  const deleteFile = useDeleteModelFile(modelId)

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      disabled={deleteFile.isPending}
      title={`Delete ${relativePath}`}
      onClick={(e) => {
        e.stopPropagation()
        if (!confirm(`Delete "${relativePath}" from this model? This creates a new commit.`)) {
          return
        }
        deleteFile.mutate(relativePath)
      }}
    >
      {deleteFile.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Trash2 className="size-4" />
      )}
    </Button>
  )
}

function RestoreButton({ modelId, entry }: { modelId: number; entry: GitLogEntry }) {
  const restore = useRestoreVersion(modelId)

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

function CaptureThumbnailButton({
  modelId,
  canvas,
  className,
}: {
  modelId: number
  canvas: HTMLCanvasElement | null
  className?: string
}) {
  const capture = useCaptureThumbnail(modelId)

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={!canvas || capture.isPending}
      onClick={() => {
        canvas?.toBlob((blob) => {
          if (blob) capture.mutate(blob)
        }, "image/png")
      }}
      title="Save the current view as the thumbnail"
      className={className}
    >
      {capture.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Camera className="size-4" />
      )}
      Capture
    </Button>
  )
}

function RegenerateThumbnailButton({
  modelId,
  className,
}: {
  modelId: number
  className?: string
}) {
  const regenerate = useRegenerateThumbnail(modelId)

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
