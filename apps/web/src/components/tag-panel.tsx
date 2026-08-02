import type { TagWithCount } from "@model-hub/shared"
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Search, Tag as TagIcon, X } from "lucide-react"
import { useMemo, useState } from "react"
import { CreateTagDialog } from "@/components/create-tag-dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

type SortKey = "name" | "count"
type SortDir = "asc" | "desc"

interface TagPanelProps {
  tags: TagWithCount[] | undefined
  isLoading: boolean
  activeTag: string | null
  onSelectTag: (tag: string | null) => void
  className?: string
}

export function TagPanel({ tags, isLoading, activeTag, onSelectTag, className }: TagPanelProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("name")
  const [sortDir, setSortDir] = useState<SortDir>("asc")

  const visibleTags = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q ? (tags ?? []).filter((tag) => tag.name.toLowerCase().includes(q)) : (tags ?? [])
    const sorted = [...filtered].sort((a, b) => {
      const cmp = sortKey === "name" ? a.name.localeCompare(b.name) : a.projectCount - b.projectCount
      return sortDir === "asc" ? cmp : -cmp
    })
    return sorted
  }, [tags, search, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("asc")
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm font-medium lg:hidden"
      >
        <span className="flex items-center gap-2">
          <TagIcon className="size-4" />
          Tags
          {activeTag && <span className="text-muted-foreground">— {activeTag}</span>}
        </span>
        <ChevronDown className={cn("size-4 transition-transform", isOpen && "rotate-180")} />
      </button>

      <div className={cn("mt-2 lg:mt-0 lg:block", isOpen ? "block" : "hidden")}>
        <div className="rounded-lg border">
          <div className="flex items-center gap-1 border-b p-2">
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tags…"
                className="h-7 pl-7 text-xs"
              />
            </div>
            <CreateTagDialog />
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-x-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => toggleSort("name")}
              className="flex items-center gap-1 text-left font-medium hover:text-foreground"
            >
              Name
              <SortIcon active={sortKey === "name"} dir={sortDir} />
            </button>
            <button
              type="button"
              onClick={() => toggleSort("count")}
              className="flex items-center gap-1 font-medium hover:text-foreground"
            >
              Count
              <SortIcon active={sortKey === "count"} dir={sortDir} />
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {isLoading ? (
              <div className="flex flex-col gap-1.5 p-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : visibleTags.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                {search ? "No tags match." : "No tags yet."}
              </p>
            ) : (
              <ul>
                {visibleTags.map((tag) => (
                  <li key={tag.id}>
                    <button
                      type="button"
                      onClick={() => onSelectTag(activeTag === tag.name ? null : tag.name)}
                      className={cn(
                        "grid w-full grid-cols-[1fr_auto] items-center gap-x-2 px-3 py-1.5 text-left text-sm hover:bg-muted",
                        activeTag === tag.name && "bg-muted font-medium",
                      )}
                    >
                      <span className="truncate">{tag.name}</span>
                      <span className="text-xs text-muted-foreground">{tag.projectCount}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {activeTag && (
            <div className="border-t p-2">
              <button
                type="button"
                onClick={() => onSelectTag(null)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
                Clear filter
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ArrowUpDown className="size-3" />
  return dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
}
