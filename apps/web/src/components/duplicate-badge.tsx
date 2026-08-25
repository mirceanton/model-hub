import type { DuplicateModelRef } from "@model-hub/shared"
import { Copy } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * Small indicator shown wherever a Model with a non-empty duplicateModels
 * list is rendered (grid card, detail header) — the full linked list of
 * which other model(s) it matches lives on the detail page (see
 * DuplicateAlert in routes/model-detail.tsx), since a grid card is already
 * one big <Link> and can't nest another.
 */
export function DuplicateBadge({
  duplicates,
  className,
}: {
  duplicates: DuplicateModelRef[]
  className?: string
}) {
  if (duplicates.length === 0) return null

  const title = `Shares a file with: ${duplicates.map((d) => d.modelTitle).join(", ")}`

  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        "gap-1 border-amber-400/50 bg-amber-400/10 text-amber-600 dark:text-amber-400",
        className,
      )}
    >
      <Copy className="size-3" />
      Possible duplicate
    </Badge>
  )
}
