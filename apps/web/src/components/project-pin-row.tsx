import type { GitLogEntry, ModelDetail, PinnedModel } from "@model-hub/shared"
import { ArrowUpCircle, Box, GitCommitHorizontal, Loader2, Trash2 } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { SyncStatusBadge } from "@/components/sync-status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { formatDateTime } from "@/lib/format"
import { thumbnailUrl } from "@/lib/model-loader"
import { useModel, useModelDiff, useRemovePin, useUpdatePin } from "@/lib/queries"
import { cn } from "@/lib/utils"

export function ProjectPinRow({
  projectId,
  pin,
  selectable,
  selected,
  onToggleSelect,
}: {
  projectId: number
  pin: PinnedModel
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const removePin = useRemovePin(projectId)
  const { data: model } = useModel(pin.modelId)

  return (
    <li className="flex items-center gap-3 rounded-lg border px-3 py-2">
      {selectable && (
        <Checkbox
          checked={!!selected}
          onCheckedChange={() => onToggleSelect?.()}
          aria-label={`Select ${pin.modelTitle}`}
          className="shrink-0"
        />
      )}
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/50">
        {pin.thumbnailStatus === "ready" ? (
          <img
            src={thumbnailUrl(pin.modelId, pin.pinnedAt)}
            alt={pin.modelTitle}
            className="size-full object-cover"
          />
        ) : (
          <Box className="size-5 text-muted-foreground/40" />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link to={`/models/${pin.modelId}`} className="truncate text-sm font-medium hover:underline">
            {pin.modelTitle}
          </Link>
          <SyncStatusBadge status={pin.modelSyncStatus} />
          {pin.isOutdated && (
            <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
              outdated
            </Badge>
          )}
        </div>
        <span className="truncate text-xs text-muted-foreground">
          {pin.pinnedCommitMessage} ·{" "}
          <span className="font-mono">{pin.pinnedCommitSha.slice(0, 10)}</span>
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {pin.isOutdated && model?.lastSyncedCommitSha && (
          <BumpToLatestDialog projectId={projectId} pin={pin} model={model} />
        )}
        <RepinDialog projectId={projectId} pin={pin} model={model} />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${pin.modelTitle} from project`}
          disabled={removePin.isPending}
          onClick={() => removePin.mutate(pin.modelId)}
        >
          {removePin.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Trash2 className="size-4" />
          )}
        </Button>
      </div>
    </li>
  )
}

/** The "bump to latest" quick action — shows the diff to the model's current commit before confirming. */
function BumpToLatestDialog({
  projectId,
  pin,
  model,
}: {
  projectId: number
  pin: PinnedModel
  model: ModelDetail
}) {
  const [open, setOpen] = useState(false)
  const updatePin = useUpdatePin(projectId)
  const targetSha = model.lastSyncedCommitSha!
  const targetEntry = model.gitLog.find((entry) => entry.sha === targetSha)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" title="Pin to latest" />}>
        <ArrowUpCircle className="size-4" />
        Latest
      </DialogTrigger>
      <DialogContent>
        <PinDiffPreview
          pin={pin}
          targetSha={targetSha}
          targetEntry={targetEntry}
          onConfirm={() =>
            updatePin.mutate({ modelId: pin.modelId }, { onSuccess: () => setOpen(false) })
          }
          onCancel={() => setOpen(false)}
          confirming={updatePin.isPending}
          confirmError={updatePin.error}
        />
      </DialogContent>
    </Dialog>
  )
}

/** Manual re-pin: pick a commit, then confirm from a diff preview against the currently pinned commit. */
function RepinDialog({
  projectId,
  pin,
  model,
}: {
  projectId: number
  pin: PinnedModel
  model: ModelDetail | undefined
}) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<GitLogEntry | null>(null)
  const updatePin = useUpdatePin(projectId)

  function close(next: boolean) {
    setOpen(next)
    if (!next) setTarget(null)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Change pinned commit for ${pin.modelTitle}`}
          />
        }
      >
        <GitCommitHorizontal className="size-4" />
      </DialogTrigger>
      <DialogContent>
        {target ? (
          <PinDiffPreview
            pin={pin}
            targetSha={target.sha}
            targetEntry={target}
            onConfirm={() =>
              updatePin.mutate(
                { modelId: pin.modelId, commitSha: target.sha },
                { onSuccess: () => close(false) },
              )
            }
            onCancel={() => setTarget(null)}
            cancelLabel="Back"
            confirming={updatePin.isPending}
            confirmError={updatePin.error}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Pin {pin.modelTitle} to a commit</DialogTitle>
              <DialogDescription>Choose which commit this project should point at.</DialogDescription>
            </DialogHeader>

            <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
              {!model ? (
                <Loader2 className="mx-auto size-4 animate-spin" />
              ) : model.gitLog.length === 0 ? (
                <p className="text-sm text-muted-foreground">No commit history yet.</p>
              ) : (
                model.gitLog.map((entry) => (
                  <button
                    key={entry.sha}
                    type="button"
                    disabled={entry.sha === pin.pinnedCommitSha}
                    onClick={() => setTarget(entry)}
                    className={cn(
                      "flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60",
                      entry.sha === pin.pinnedCommitSha && "border-primary bg-muted/50",
                    )}
                  >
                    <span>{entry.message}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(entry.date)} ·{" "}
                      <span className="font-mono">{entry.sha.slice(0, 10)}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The confirm-before-bump step shared by both pin-bump entry points (manual
 * re-pin and "bump to latest"): fetches GET /api/models/:id/diff between
 * the currently pinned commit and the proposed target, and shows the
 * intervening commit log plus a file-level add/modified/removed change
 * list before letting the user confirm the PATCH. See issue #68 — file-list
 * diff only, no geometric/visual mesh comparison.
 */
function PinDiffPreview({
  pin,
  targetSha,
  targetEntry,
  onConfirm,
  onCancel,
  cancelLabel = "Cancel",
  confirming,
  confirmError,
}: {
  pin: PinnedModel
  targetSha: string
  targetEntry: GitLogEntry | undefined
  onConfirm: () => void
  onCancel: () => void
  cancelLabel?: string
  confirming: boolean
  confirmError: Error | null
}) {
  const { data: diff, isPending, isError, error } = useModelDiff(pin.modelId, pin.pinnedCommitSha, targetSha)

  return (
    <>
      <DialogHeader>
        <DialogTitle>Bump {pin.modelTitle}&rsquo;s pin</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{pin.pinnedCommitSha.slice(0, 10)}</span> &rarr;{" "}
          <span className="font-mono">{targetSha.slice(0, 10)}</span>
          {targetEntry ? `: ${targetEntry.message}` : null}
        </DialogDescription>
      </DialogHeader>

      <div className="flex max-h-72 flex-col gap-3 overflow-y-auto text-sm">
        {isPending ? (
          <Loader2 className="mx-auto size-4 animate-spin" />
        ) : isError ? (
          <p className="text-destructive">{error.message}</p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-muted-foreground">
                {diff.commits.length} commit{diff.commits.length === 1 ? "" : "s"} in between
              </h3>
              {diff.commits.length === 0 ? (
                <p className="text-xs text-muted-foreground">No intervening commits.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {diff.commits.map((commit) => (
                    <li key={commit.sha} className="rounded-md border px-2 py-1">
                      <p className="truncate">{commit.message}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(commit.date)} ·{" "}
                        <span className="font-mono">{commit.sha.slice(0, 10)}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-muted-foreground">
                {diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed
              </h3>
              {diff.files.length === 0 ? (
                <p className="text-xs text-muted-foreground">No file changes.</p>
              ) : (
                <ul className="flex flex-col gap-1 font-mono text-xs">
                  {diff.files.map((file) => (
                    <li key={file.path} className="flex items-center gap-2">
                      <Badge
                        variant={
                          file.status === "added"
                            ? "default"
                            : file.status === "removed"
                              ? "destructive"
                              : "outline"
                        }
                        className="w-5 shrink-0 justify-center px-0"
                      >
                        {file.status[0].toUpperCase()}
                      </Badge>
                      <span className="truncate">{file.path}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
        {confirmError && <p className="text-destructive">{confirmError.message}</p>}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={confirming}>
          {cancelLabel}
        </Button>
        <Button onClick={onConfirm} disabled={confirming || isPending || isError}>
          {confirming && <Loader2 className="size-4 animate-spin" />}
          Confirm bump
        </Button>
      </DialogFooter>
    </>
  )
}
