import { useCallback, useMemo, useState } from "react"

/**
 * Multi-select state for a list of items keyed by `TId` (model id, project
 * id, or a file's relativePath) — shared by the four bulk-select surfaces
 * (library grid, project list, a model's file list, a project's pinned
 * models). `active` gates whether checkboxes/the action bar are shown at
 * all; turning it off always clears the selection so re-entering select
 * mode never resurrects a stale selection from a previous visit.
 */
export function useSelection<TId>() {
  const [active, setActive] = useState(false)
  const [selected, setSelected] = useState<Set<TId>>(new Set())

  const setActiveAndClear = useCallback((next: boolean) => {
    setActive(next)
    setSelected(new Set())
  }, [])

  const toggle = useCallback((id: TId) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clear = useCallback(() => setSelected(new Set()), [])

  const selectAll = useCallback((ids: TId[]) => setSelected(new Set(ids)), [])

  const isSelected = useCallback((id: TId) => selected.has(id), [selected])

  return useMemo(
    () => ({ active, setActive: setActiveAndClear, selected, toggle, clear, selectAll, isSelected }),
    [active, setActiveAndClear, selected, toggle, clear, selectAll, isSelected],
  )
}
