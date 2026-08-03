import type { PinnedModel } from "@model-hub/shared"
import { ArrowUpCircle, Box, GitCommitHorizontal, Loader2, Trash2 } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { SyncStatusBadge } from "@/components/sync-status-badge"
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
import { formatDateTime } from "@/lib/format"
import { thumbnailUrl } from "@/lib/model-loader"
import { useModel, useRemovePin, useUpdatePin } from "@/lib/queries"
import { cn } from "@/lib/utils"

export function ProjectPinRow({ projectId, pin }: { projectId: number; pin: PinnedModel }) {
  const updatePin = useUpdatePin(projectId)
  const removePin = useRemovePin(projectId)

  return (
    <li className="flex items-center gap-3 rounded-lg border px-3 py-2">
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
        {pin.isOutdated && (
          <Button
            variant="ghost"
            size="sm"
            disabled={updatePin.isPending}
            onClick={() => updatePin.mutate({ modelId: pin.modelId })}
            title="Pin to latest"
          >
            {updatePin.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowUpCircle className="size-4" />
            )}
            Latest
          </Button>
        )}
        <RepinDialog projectId={projectId} pin={pin} />
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

function RepinDialog({ projectId, pin }: { projectId: number; pin: PinnedModel }) {
  const [open, setOpen] = useState(false)
  const { data: model } = useModel(pin.modelId)
  const updatePin = useUpdatePin(projectId)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
                disabled={updatePin.isPending}
                onClick={() =>
                  updatePin.mutate(
                    { modelId: pin.modelId, commitSha: entry.sha },
                    { onSuccess: () => setOpen(false) },
                  )
                }
                className={cn(
                  "flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted",
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
      </DialogContent>
    </Dialog>
  )
}
