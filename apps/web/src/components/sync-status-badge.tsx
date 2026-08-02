import type { SyncStatus } from "@model-hub/shared"
import { Badge } from "@/components/ui/badge"

const VARIANT_BY_STATUS = {
  ok: "secondary",
  error: "destructive",
  missing: "outline",
} as const

export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  return <Badge variant={VARIANT_BY_STATUS[status]}>{status}</Badge>
}
