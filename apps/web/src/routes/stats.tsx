import type { ThumbnailStatus } from "@model-hub/shared"
import { AlertCircle, HardDrive, Image as ImageIcon, Layers, RefreshCw, Server } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatBytes, formatDateTime } from "@/lib/format"
import { useAuthMe, useInstanceStats } from "@/lib/queries"

const THUMBNAIL_STATUS_LABELS: Record<ThumbnailStatus, string> = {
  pending: "Pending",
  generating: "Generating",
  ready: "Ready",
  error: "Error",
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

function StorageCard() {
  const { data } = useInstanceStats()
  if (!data) return null
  const { storage } = data

  const volumeUsedBytes = storage.volumeTotalBytes - storage.volumeFreeBytes
  const usedPct =
    storage.volumeTotalBytes > 0 ? Math.min(100, (volumeUsedBytes / storage.volumeTotalBytes) * 100) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4" />
          Storage
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${usedPct}%` }} />
          </div>
          <span className="text-xs text-muted-foreground">
            {formatBytes(volumeUsedBytes)} of {formatBytes(storage.volumeTotalBytes)} used on volume
          </span>
        </div>
        <StatRow label="Library size (LIBRARY_ROOT)" value={formatBytes(storage.libraryUsedBytes)} />
        <StatRow label="Available to this instance" value={formatBytes(storage.volumeAvailableBytes)} />
      </CardContent>
    </Card>
  )
}

function CountsCard() {
  const { data } = useInstanceStats()
  if (!data) return null
  const { counts } = data

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="size-4" />
          Library
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <StatRow label="Models" value={counts.models} />
        <StatRow label="Projects" value={counts.projects} />
        <StatRow label="Tags" value={counts.tags} />
        <div className="flex flex-col gap-1.5 pt-1">
          <span className="text-xs text-muted-foreground">Thumbnails by status</span>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(THUMBNAIL_STATUS_LABELS) as ThumbnailStatus[]).map((status) => (
              <Badge key={status} variant={status === "error" ? "destructive" : "outline"}>
                {THUMBNAIL_STATUS_LABELS[status]}: {counts.thumbnailStatus[status]}
              </Badge>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ThumbnailQueueCard() {
  const { data } = useInstanceStats()
  if (!data) return null
  const { thumbnailQueue } = data

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ImageIcon className="size-4" />
          Thumbnail queue
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <StatRow label="Waiting" value={thumbnailQueue.pending} />
        <StatRow label="Rendering" value={thumbnailQueue.active} />
      </CardContent>
    </Card>
  )
}

function SyncHealthCard() {
  const { data } = useInstanceStats()
  if (!data) return null
  const { sync } = data

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="size-4" />
          Sync health
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <StatRow
          label="Last full scan"
          value={sync.lastScanAt ? formatDateTime(sync.lastScanAt) : "Never (since this process started)"}
        />
        <StatRow
          label="Last scan duration"
          value={sync.lastScanDurationSeconds != null ? `${sync.lastScanDurationSeconds.toFixed(2)}s` : "—"}
        />
        <StatRow
          label="Models with sync errors"
          value={
            sync.errorModelCount > 0 ? (
              <Badge variant="destructive">{sync.errorModelCount}</Badge>
            ) : (
              sync.errorModelCount
            )
          }
        />
        <StatRow
          label="Missing models"
          value={
            sync.missingModelCount > 0 ? (
              <Badge variant="destructive">{sync.missingModelCount}</Badge>
            ) : (
              sync.missingModelCount
            )
          }
        />
      </CardContent>
    </Card>
  )
}

function InstanceInfoCard() {
  const { data } = useInstanceStats()
  if (!data) return null
  const { instance } = data

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4" />
          Instance
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <StatRow label="Version" value={instance.version} />
        <StatRow
          label="OIDC login"
          value={
            <Badge variant={instance.oidcEnabled ? "default" : "outline"}>
              {instance.oidcEnabled ? "Enabled" : "Disabled (single-user mode)"}
            </Badge>
          }
        />
        <StatRow label="Library root" value={<span className="font-mono text-xs">{instance.libraryRoot}</span>} />
      </CardContent>
    </Card>
  )
}

export function StatsPage() {
  const { data: authMe, isPending: authPending } = useAuthMe()
  const { isPending, isError, error } = useInstanceStats()

  if (authPending) {
    return <Skeleton className="h-64 w-full rounded-lg" />
  }

  if (authMe?.user?.role !== "admin") {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Admins only</AlertTitle>
        <AlertDescription>You don't have permission to view this page.</AlertDescription>
      </Alert>
    )
  }

  if (isPending) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">Stats</h1>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Couldn't load instance stats</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Stats</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StorageCard />
        <CountsCard />
        <ThumbnailQueueCard />
        <SyncHealthCard />
        <InstanceInfoCard />
      </div>
    </div>
  )
}
