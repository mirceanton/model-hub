import { AlertCircle, Loader2, RotateCcw, Trash } from "lucide-react"
import { ModelThumbnail } from "@/components/model-thumbnail"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDateTime } from "@/lib/format"
import { usePurgeFromTrash, useRestoreFromTrash, useTrash } from "@/lib/queries"

// Mirrors the server's TRASH_RETENTION_MS (apps/server/src/sync/scanner.ts) —
// purely informational here, the server is the source of truth for the
// actual purge.
const TRASH_RETENTION_DAYS = 7

export function TrashPage() {
  const { data: items, isPending, isError, error } = useTrash()

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Trash</h1>
        <p className="text-sm text-muted-foreground">
          Deleted models are kept here for {TRASH_RETENTION_DAYS} days before being permanently
          removed. Restore a model to bring it back to the library, fully intact.
        </p>
      </div>

      {isPending ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Couldn't load the trash</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-24 text-center text-muted-foreground">
          <Trash className="size-8" />
          <p className="font-medium text-foreground">Trash is empty</p>
          <p className="text-sm">Deleted models will show up here.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <Card key={item.id} className="py-3">
              <CardContent className="flex items-center gap-3 px-3">
                <ModelThumbnail
                  model={{ id: item.id, title: item.title, thumbnailStatus: item.thumbnailStatus, updatedAt: item.deletedAt }}
                  className="size-14 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">
                    Deleted {formatDateTime(item.deletedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <RestoreButton id={item.id} />
                  <PurgeButton id={item.id} title={item.title} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function RestoreButton({ id }: { id: number }) {
  const restore = useRestoreFromTrash()

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={restore.isPending}
      onClick={() => restore.mutate(id)}
    >
      {restore.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <RotateCcw className="size-4" />
      )}
      Restore
    </Button>
  )
}

function PurgeButton({ id, title }: { id: number; title: string }) {
  const purge = usePurgeFromTrash()

  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      disabled={purge.isPending}
      onClick={() => {
        if (
          !confirm(
            `Permanently delete "${title}"? This removes its directory (files and history) from disk and cannot be undone.`,
          )
        ) {
          return
        }
        purge.mutate(id)
      }}
    >
      {purge.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash className="size-4" />}
      Delete forever
    </Button>
  )
}
