import type { Model, ModelSortField, SortOrder } from "@model-hub/shared"
import { AlertCircle, ChevronLeft, ChevronRight, FolderOpen, Search, Star } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { useMainMaxWidth } from "@/components/app-shell"
import { CreateModelDialog } from "@/components/create-model-dialog"
import { DuplicateBadge } from "@/components/duplicate-badge"
import { FavoriteToggle } from "@/components/favorite-toggle"
import { ModelThumbnail } from "@/components/model-thumbnail"
import { SyncStatusBadge } from "@/components/sync-status-badge"
import { TagPanel } from "@/components/tag-panel"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { formatDateTime } from "@/lib/format"
import { useModels, useTags, useUpdateModel } from "@/lib/queries"
import { tagBadgeStyle } from "@/lib/tag-colors"
import { cn } from "@/lib/utils"

const SEARCH_DEBOUNCE_MS = 250

// Card columns the user can pick, and the responsive breakpoint progression
// leading up to each — screens narrower than the target still step down
// through fewer columns, same as before this became user-selectable.
const COLUMN_OPTIONS = [3, 4, 5] as const
const DEFAULT_COLUMNS = 3
const COLUMN_GRID_CLASSES: Record<(typeof COLUMN_OPTIONS)[number], string> = {
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
  5: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5",
}

// Items-per-page options scale with the column count so a page is always a
// whole number of full rows (e.g. 3 columns -> 12/24/48/96, 4 -> 16/32/64/128).
const PER_PAGE_ROW_MULTIPLIERS = [4, 8, 16, 32]
const DEFAULT_PER_PAGE_INDEX = 0

// Card size is pinned to the 3-column layout at the old max-w-6xl (72rem)
// container; widening the container (not shrinking cards) is how extra
// columns fit at a given card size. The container's width is shared with
// the fixed-width tag sidebar (18rem + 1.5rem gap, see the lg:grid-cols
// below), so that fixed chunk has to be subtracted out before dividing the
// rest into cards, and added back when computing the new total width.
const BASE_MAX_WIDTH_REM = 72
const BASE_COLUMNS = 3
const GRID_GAP_REM = 1
const CONTAINER_PADDING_REM = 2
const SIDEBAR_WIDTH_REM = 18
const SIDEBAR_GAP_REM = 1.5
const FIXED_CHROME_REM = CONTAINER_PADDING_REM + SIDEBAR_GAP_REM + SIDEBAR_WIDTH_REM
const CARD_WIDTH_REM =
  (BASE_MAX_WIDTH_REM - FIXED_CHROME_REM - GRID_GAP_REM * (BASE_COLUMNS - 1)) / BASE_COLUMNS

function mainMaxWidthForColumns(columns: number) {
  if (columns === BASE_COLUMNS) return null
  const width = FIXED_CHROME_REM + columns * CARD_WIDTH_REM + GRID_GAP_REM * (columns - 1)
  return `${width.toFixed(2)}rem`
}

interface SortOption {
  value: string
  label: string
  sort: ModelSortField
  order: SortOrder
}

const SORT_OPTIONS: SortOption[] = [
  { value: "title-asc", label: "Name (A–Z)", sort: "title", order: "asc" },
  { value: "title-desc", label: "Name (Z–A)", sort: "title", order: "desc" },
  { value: "createdAt-desc", label: "Recently added", sort: "createdAt", order: "desc" },
  { value: "createdAt-asc", label: "Oldest first", sort: "createdAt", order: "asc" },
]
const DEFAULT_SORT = SORT_OPTIONS[0]

export function ModelListPage() {
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  // Active tag filters (AND) live in the URL, not component state, so the
  // filtered view is shareable/bookmarkable — everything else here (search,
  // sort, pagination, column count) stays session-local, matching prior
  // behavior.
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTags = useMemo(() => searchParams.getAll("tag"), [searchParams])
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [columns, setColumns] = useState<(typeof COLUMN_OPTIONS)[number]>(DEFAULT_COLUMNS)
  const [perPageIndex, setPerPageIndex] = useState(DEFAULT_PER_PAGE_INDEX)
  const [page, setPage] = useState(1)
  const [sortValue, setSortValue] = useState(DEFAULT_SORT.value)

  const perPage = PER_PAGE_ROW_MULTIPLIERS[perPageIndex] * columns
  const sortOption = SORT_OPTIONS.find((option) => option.value === sortValue) ?? DEFAULT_SORT

  useMainMaxWidth(mainMaxWidthForColumns(columns))

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    setPage(1)
  }, [search, activeTags, favoritesOnly, perPage, sortValue])

  function toggleTag(tag: string) {
    setSearchParams(
      (prev) => {
        const current = prev.getAll("tag")
        const next = new URLSearchParams(prev)
        next.delete("tag")
        for (const t of current.includes(tag) ? current.filter((t2) => t2 !== tag) : [...current, tag]) {
          next.append("tag", t)
        }
        return next
      },
      { replace: true },
    )
  }

  function clearTags() {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("tag")
        return next
      },
      { replace: true },
    )
  }

  const { data: tags, isPending: tagsPending } = useTags()
  const {
    data: models,
    isPending,
    isError,
    error,
  } = useModels({
    q: search || undefined,
    tags: activeTags.length > 0 ? activeTags : undefined,
    favorite: favoritesOnly || undefined,
    page,
    perPage,
    sort: sortOption.sort,
    order: sortOption.order,
  })

  const isFiltered = search.trim().length > 0 || activeTags.length > 0 || favoritesOnly
  const total = models?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / perPage))

  return (
    <div className="grid grid-cols-1 gap-y-4 [grid-template-areas:'search'_'tags'_'content'] lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-x-6 lg:[grid-template-areas:'search_tags'_'content_tags']">
      <div className="flex flex-wrap items-center justify-between gap-2 [grid-area:search]">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by title…"
              className="pl-8"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={favoritesOnly}
            onClick={() => setFavoritesOnly((v) => !v)}
            className={cn(favoritesOnly && "border-amber-400/50 bg-amber-400/10 text-amber-600 dark:text-amber-400")}
          >
            <Star className={cn("size-3.5", favoritesOnly && "fill-current")} />
            Favorites
          </Button>
          <Select value={sortValue} onValueChange={(value) => value && setSortValue(value)}>
            <SelectTrigger size="sm" aria-label="Sort by">
              <SelectValue>
                {(value: string) => SORT_OPTIONS.find((option) => option.value === value)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(columns)}
            onValueChange={(value) => setColumns(Number(value) as (typeof COLUMN_OPTIONS)[number])}
          >
            <SelectTrigger size="sm" aria-label="Columns">
              <SelectValue>{(value: string) => `${value} columns`}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {COLUMN_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option} columns
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(perPageIndex)}
            onValueChange={(value) => setPerPageIndex(Number(value))}
          >
            <SelectTrigger size="sm" aria-label="Items per page">
              <SelectValue>
                {(value: string) => `${PER_PAGE_ROW_MULTIPLIERS[Number(value)] * columns} per page`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PER_PAGE_ROW_MULTIPLIERS.map((multiplier, index) => (
                <SelectItem key={multiplier} value={String(index)}>
                  {multiplier * columns} per page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CreateModelDialog />
      </div>

      <div className="min-w-0 [grid-area:content]">
        {isPending ? (
          <div className={cn("grid gap-4", COLUMN_GRID_CLASSES[columns])}>
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[4/5] w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Couldn't load your library</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : models.data.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-24 text-center text-muted-foreground">
            <FolderOpen className="size-8" />
            <p className="font-medium text-foreground">
              {isFiltered ? "No models match" : "No models yet"}
            </p>
            <p className="text-sm">
              {isFiltered
                ? "Try a different search or tag."
                : "Drop a folder into your library directory to get started."}
            </p>
          </div>
        ) : (
          <>
            <div className={cn("grid gap-4", COLUMN_GRID_CLASSES[columns])}>
              {models.data.map((model) => (
                <ModelCard key={model.id} model={model} />
              ))}
            </div>
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="size-3.5" />
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <TagPanel
        tags={tags}
        isLoading={tagsPending}
        activeTags={activeTags}
        onToggleTag={toggleTag}
        onClearTags={clearTags}
        className="[grid-area:tags]"
      />
    </div>
  )
}

function ModelCard({ model }: { model: Model }) {
  const update = useUpdateModel(model.id)

  return (
    <Link to={`/models/${model.id}`}>
      <Card className="h-full gap-3 py-3 transition-colors hover:border-foreground/20">
        <CardHeader className="relative px-3">
          <ModelThumbnail model={model} />
          <FavoriteToggle
            favorite={model.favorite}
            onToggle={() => update.mutate({ favorite: !model.favorite })}
            className="absolute top-2 right-2 bg-background/80 backdrop-blur-sm hover:bg-background"
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5 px-3">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="line-clamp-1 text-sm">{model.title}</CardTitle>
            <SyncStatusBadge status={model.syncStatus} />
          </div>
          <p className="line-clamp-1 text-xs text-muted-foreground">
            {model.primaryFilePath ?? "No model files"}
          </p>
          {model.duplicateModels.length > 0 && (
            <div>
              <DuplicateBadge duplicates={model.duplicateModels} className="text-[10px]" />
            </div>
          )}
          {model.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {model.tags.map((tag) => (
                <Badge
                  key={tag.id}
                  variant="outline"
                  className="text-[10px]"
                  style={tagBadgeStyle(tag.color)}
                >
                  {tag.name}
                </Badge>
              ))}
            </div>
          )}
          {model.lastSyncedAt && (
            <p className="text-xs text-muted-foreground/70">
              Synced {formatDateTime(model.lastSyncedAt)}
            </p>
          )}
        </CardContent>
      </Card>
    </Link>
  )
}
