import type { BulkResponse } from "@model-hub/shared"
import { AlertTriangle, X } from "lucide-react"
import type { ReactNode } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

/**
 * The selection-mode toolbar shown across the top of a bulk-select surface
 * (library grid, a model's file list, a project's pinned models, the
 * project list) once at least one item is checked. `children` are the
 * action buttons for that surface (favorite/tag/delete, bump/remove, ...);
 * this component only owns the count/clear chrome common to all of them.
 */
export function BulkActionBar({
  count,
  onClear,
  children,
}: {
  count: number
  onClear: () => void
  children: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
      <span className="text-sm font-medium">
        {count} selected
      </span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onClear}>
        <X className="size-3.5" />
        Clear
      </Button>
    </div>
  )
}

/**
 * Turns a BulkResponse into a per-item failure summary — the point of the
 * server returning per-item results instead of one opaque error (see
 * packages/shared/src/types.ts's BulkResponse doc comment) is exactly so
 * the UI can show this instead of either silently swallowing partial
 * failures or treating the whole batch as failed. Renders nothing when
 * every item succeeded.
 */
export function BulkFailureAlert<TId extends string | number>({
  response,
  labelFor,
}: {
  response: BulkResponse<TId> | undefined
  /** Renders a human-readable label for one failed item's id (a model title, a file path, ...). */
  labelFor?: (id: TId) => string
}) {
  const failures = response?.results.filter((r) => !r.success) ?? []
  if (failures.length === 0) return null

  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>
        {failures.length} of {response!.results.length} failed
      </AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-0.5">
          {failures.map((f) => (
            <li key={String(f.id)}>
              {labelFor ? labelFor(f.id) : String(f.id)}
              {f.error ? `: ${f.error}` : ""}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
