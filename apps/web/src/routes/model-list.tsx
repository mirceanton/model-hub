import type { BulkResponse, Model, ModelSortField, SortOrder } from "@model-hub/shared"
import {
  AlertCircle,
  Archive,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  ListChecks,
  ListFilter,
  Loader2,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { useMainMaxWidth } from "@/components/app-shell"
import { BulkActionBar, BulkFailureAlert } from "@/components/bulk-action-bar"
import { BulkAddTagButton, BulkRemoveTagButton } from "@/components/bulk-tag-dialogs"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useSelection } from "@/hooks/use-selection"
import { formatDateTime } from "@/lib/format"
import { useBulkModelsAction, useExportModels, useModels, useTags, useUpdateModel } from "@/lib/queries"
import { tagBadgeStyle } from "@/lib/tag-colors"
import { cn } from "@/lib/utils"

const SEARCH_DEBOUNCE_MS = 250

// Column count is auto-calculated from screen width, not user-selected (#94):
// cards keep a fixed target width, and the grid's auto-fill/minmax decides how
// many fit per row for the current viewport, from 1 up to MAX_COLUMNS.
const MAX_COLUMNS = 5

// Items-per-page options. Previously scaled with the (user-selected) column
// count so a page was always a whole number of full rows; now that column
// count is fluid, these are just fixed values.
const PER_PAGE_OPTIONS = [20, 40, 80, 160]
const DEFAULT_PER_PAGE_INDEX = 0

// Card size is pinned to the original 3-column layout at the old max-w-6xl
// (72rem) container, so cards don't change size — only their count per row
// does. The container's width is shared with the fixed-width tag sidebar
// (18rem + 1.5rem gap, see the lg:grid-cols below), so that fixed chunk has
// to be subtracted out before dividing the rest into cards. The container is
// then widened to fit MAX_COLUMNS cards at that same card size; the grid
// itself (via auto-fill/minmax) decides how many actually fit at narrower
// viewports, down to 1.
const BASE_MAX_WIDTH_REM = 72
const BASE_COLUMNS = 3
const GRID_GAP_REM = 1
const CONTAINER_PADDING_REM = 2
const SIDEBAR_WIDTH_REM = 18
const SIDEBAR_GAP_REM = 1.5
const FIXED_CHROME_REM = CONTAINER_PADDING_REM + SIDEBAR_GAP_REM + SIDEBAR_WIDTH_REM
// Rounded once and reused below (rather than carrying the repeating decimal
// through both computations) so the container is widened using the exact
// same per-card width the grid's minmax() uses — any mismatch there is what
// would make auto-fill round down to MAX_COLUMNS - 1 at the target width.
const CARD_WIDTH_REM = Number(
  ((BASE_MAX_WIDTH_REM - FIXED_CHROME_REM - GRID_GAP_REM * (BASE_COLUMNS - 1)) / BASE_COLUMNS).toFixed(2),
)
const MAIN_MAX_WIDTH_REM = `${(
  FIXED_CHROME_REM +
  MAX_COLUMNS * CARD_WIDTH_REM +
  GRID_GAP_REM * (MAX_COLUMNS - 1)
).toFixed(2)}rem`
const GRID_TEMPLATE_COLUMNS = `repeat(auto-fill, minmax(${CARD_WIDTH_REM}rem, 1fr))`

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
  { value: "lastSyncedAt-desc", label: "Recently updated", sort: "lastSyncedAt", order: "desc" },
]
const DEFAULT_SORT = SORT_OPTIONS[0]

const MB = 1024 * 1024

interface FileFilterInputs {
  extension: string
  minSizeMB: string
  maxSizeMB: string
  minFiles: string
  maxFiles: string
}

const EMPTY_FILE_FILTERS: FileFilterInputs = {
  extension: "",
  minSizeMB: "",
  maxSizeMB: "",
  minFiles: "",
  maxFiles: "",
}

/** Parses a trimmed numeric text input into a non-negative number, or undefined if blank/invalid. */
function parsePositiveNumber(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function ModelListPage() {
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  // Active tag filters (AND) live in the URL, not component state, so the
  // filtered view is shareable/bookmarkable — everything else here (search,
  // sort, pagination) stays session-local, matching prior behavior.
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTags = useMemo(() => searchParams.getAll("tag"), [searchParams])
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [perPageIndex, setPerPageIndex] = useState(DEFAULT_PER_PAGE_INDEX)
  const [page, setPage] = useState(1)
  const [sortValue, setSortValue] = useState(DEFAULT_SORT.value)
  // File-attribute filters (extension present, size range, file-count range)
  // — session-local like search/sort above, not part of the shareable URL.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [fileFilterInputs, setFileFilterInputs] = useState<FileFilterInputs>(EMPTY_FILE_FILTERS)
  const [fileFilters, setFileFilters] = useState<FileFilterInputs>(EMPTY_FILE_FILTERS)

  const selection = useSelection<number>()
  const bulkAction = useBulkModelsAction()
  const exportModels = useExportModels()
  const [bulkResult, setBulkResult] = useState<BulkResponse | undefined>()
  function handleBulkSuccess(data: BulkResponse) {
    setBulkResult(data)
    selection.clear()
  }

  const perPage = PER_PAGE_OPTIONS[perPageIndex]
  const sortOption = SORT_OPTIONS.find((option) => option.value === sortValue) ?? DEFAULT_SORT

  useMainMaxWidth(MAIN_MAX_WIDTH_REM)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    const timer = setTimeout(() => setFileFilters(fileFilterInputs), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [fileFilterInputs])

  useEffect(() => {
    setPage(1)
  }, [search, activeTags, favoritesOnly, fileFilters, perPage, sortValue])

  const extensionFilter = fileFilters.extension.trim().toLowerCase() || undefined
  const minSizeMB = parsePositiveNumber(fileFilters.minSizeMB)
  const maxSizeMB = parsePositiveNumber(fileFilters.maxSizeMB)
  const minFilesFilter = parsePositiveNumber(fileFilters.minFiles)
  const maxFilesFilter = parsePositiveNumber(fileFilters.maxFiles)
  const hasFileFilters =
    extensionFilter !== undefined ||
    minSizeMB !== undefined ||
    maxSizeMB !== undefined ||
    minFilesFilter !== undefined ||
    maxFilesFilter !== undefined

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
    extension: extensionFilter,
    minSizeBytes: minSizeMB !== undefined ? Math.round(minSizeMB * MB) : undefined,
    maxSizeBytes: maxSizeMB !== undefined ? Math.round(maxSizeMB * MB) : undefined,
    minFiles: minFilesFilter,
    maxFiles: maxFilesFilter,
    page,
    perPage,
    sort: sortOption.sort,
    order: sortOption.order,
  })

  const isFiltered =
    search.trim().length > 0 || activeTags.length > 0 || favoritesOnly || hasFileFilters
  const total = models?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / perPage))

  function clearFileFilters() {
    setFileFilterInputs(EMPTY_FILE_FILTERS)
  }

  return (
    <div className="grid grid-cols-1 gap-y-4 [grid-template-areas:'search'_'tags'_'content'] lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-x-6 lg:[grid-template-areas:'search_tags'_'content_tags']">
      <div className="flex flex-col gap-3 [grid-area:search]">
        <div className="flex flex-wrap items-center justify-between gap-2">
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={filtersOpen}
              onClick={() => setFiltersOpen((v) => !v)}
              className={cn(hasFileFilters && "border-primary/50 bg-primary/10 text-primary")}
            >
              <ListFilter className="size-3.5" />
              Filters
              {hasFileFilters && (
                <Badge variant="secondary" className="ml-0.5 h-4 min-w-4 rounded-full px-1 text-[10px]">
                  {
                    [extensionFilter, minSizeMB, maxSizeMB, minFilesFilter, maxFilesFilter].filter(
                      (v) => v !== undefined,
                    ).length
                  }
                </Badge>
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={selection.active}
              onClick={() => {
                setBulkResult(undefined)
                selection.setActive(!selection.active)
              }}
              className={cn(selection.active && "border-primary/50 bg-primary/10 text-primary")}
            >
              <ListChecks className="size-3.5" />
              Select
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
              value={String(perPageIndex)}
              onValueChange={(value) => setPerPageIndex(Number(value))}
            >
              <SelectTrigger size="sm" aria-label="Items per page">
                <SelectValue>{(value: string) => `${PER_PAGE_OPTIONS[Number(value)]} per page`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PER_PAGE_OPTIONS.map((option, index) => (
                  <SelectItem key={option} value={String(index)}>
                    {option} per page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <CreateModelDialog />
        </div>

        {filtersOpen && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-extension" className="text-xs text-muted-foreground">
                File extension
              </label>
              <Input
                id="filter-extension"
                value={fileFilterInputs.extension}
                onChange={(e) =>
                  setFileFilterInputs((prev) => ({ ...prev, extension: e.target.value }))
                }
                placeholder="e.g. stl, pdf"
                className="h-8 w-32"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-min-size" className="text-xs text-muted-foreground">
                Min size (MB)
              </label>
              <Input
                id="filter-min-size"
                type="number"
                min={0}
                value={fileFilterInputs.minSizeMB}
                onChange={(e) =>
                  setFileFilterInputs((prev) => ({ ...prev, minSizeMB: e.target.value }))
                }
                placeholder="0"
                className="h-8 w-24"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-max-size" className="text-xs text-muted-foreground">
                Max size (MB)
              </label>
              <Input
                id="filter-max-size"
                type="number"
                min={0}
                value={fileFilterInputs.maxSizeMB}
                onChange={(e) =>
                  setFileFilterInputs((prev) => ({ ...prev, maxSizeMB: e.target.value }))
                }
                placeholder="Any"
                className="h-8 w-24"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-min-files" className="text-xs text-muted-foreground">
                Min files
              </label>
              <Input
                id="filter-min-files"
                type="number"
                min={0}
                value={fileFilterInputs.minFiles}
                onChange={(e) =>
                  setFileFilterInputs((prev) => ({ ...prev, minFiles: e.target.value }))
                }
                placeholder="0"
                className="h-8 w-20"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="filter-max-files" className="text-xs text-muted-foreground">
                Max files
              </label>
              <Input
                id="filter-max-files"
                type="number"
                min={0}
                value={fileFilterInputs.maxFiles}
                onChange={(e) =>
                  setFileFilterInputs((prev) => ({ ...prev, maxFiles: e.target.value }))
                }
                placeholder="Any"
                className="h-8 w-20"
              />
            </div>
            {hasFileFilters && (
              <Button type="button" variant="ghost" size="sm" onClick={clearFileFilters}>
                <X className="size-3.5" />
                Clear
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="min-w-0 [grid-area:content]">
        {isPending ? (
          <div className="grid gap-4" style={{ gridTemplateColumns: GRID_TEMPLATE_COLUMNS }}>
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
            {selection.active && (
              <div className="mb-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={models.data.every((m) => selection.isSelected(m.id))}
                      indeterminate={
                        selection.selected.size > 0 &&
                        !models.data.every((m) => selection.isSelected(m.id))
                      }
                      onCheckedChange={(checked) =>
                        checked
                          ? selection.selectAll(models.data.map((m) => m.id))
                          : selection.clear()
                      }
                    />
                    Select all on this page
                  </label>
                </div>
                {selection.selected.size > 0 && (
                  <>
                    <BulkActionBar count={selection.selected.size} onClear={selection.clear}>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={bulkAction.isPending}
                        onClick={() =>
                          bulkAction.mutate(
                            { ids: [...selection.selected], action: "favorite" },
                            { onSuccess: handleBulkSuccess },
                          )
                        }
                      >
                        <Star className="size-3.5" />
                        Favorite
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={bulkAction.isPending}
                        onClick={() =>
                          bulkAction.mutate(
                            { ids: [...selection.selected], action: "unfavorite" },
                            { onSuccess: handleBulkSuccess },
                          )
                        }
                      >
                        <Star className="size-3.5" />
                        Unfavorite
                      </Button>
                      <BulkAddTagButton
                        allTags={tags}
                        disabled={bulkAction.isPending}
                        onApply={(tagName) =>
                          bulkAction.mutate(
                            { ids: [...selection.selected], action: "add-tag", tagName },
                            { onSuccess: handleBulkSuccess },
                          )
                        }
                      />
                      <BulkRemoveTagButton
                        allTags={tags}
                        disabled={bulkAction.isPending}
                        pending={bulkAction.isPending}
                        onApply={(tagId) =>
                          bulkAction.mutate(
                            { ids: [...selection.selected], action: "remove-tag", tagId },
                            { onSuccess: handleBulkSuccess },
                          )
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={exportModels.isPending}
                        onClick={() => exportModels.mutate([...selection.selected])}
                      >
                        {exportModels.isPending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Archive className="size-3.5" />
                        )}
                        Export
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        disabled={bulkAction.isPending}
                        onClick={() => {
                          const count = selection.selected.size
                          if (!confirm(`Move ${count} model${count === 1 ? "" : "s"} to trash?`)) return
                          bulkAction.mutate(
                            { ids: [...selection.selected], action: "delete" },
                            { onSuccess: handleBulkSuccess },
                          )
                        }}
                      >
                        {bulkAction.isPending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                        Delete
                      </Button>
                    </BulkActionBar>
                    {exportModels.isError && (
                      <Alert variant="destructive">
                        <AlertCircle />
                        <AlertTitle>Export failed</AlertTitle>
                        <AlertDescription>{exportModels.error.message}</AlertDescription>
                      </Alert>
                    )}
                  </>
                )}
                <BulkFailureAlert
                  response={bulkResult}
                  labelFor={(id) => models.data.find((m) => m.id === id)?.title ?? `Model #${id}`}
                />
              </div>
            )}
            <div className="grid gap-4" style={{ gridTemplateColumns: GRID_TEMPLATE_COLUMNS }}>
              {models.data.map((model) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  selectable={selection.active}
                  selected={selection.isSelected(model.id)}
                  onToggleSelect={() => selection.toggle(model.id)}
                />
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

function ModelCard({
  model,
  selectable,
  selected,
  onToggleSelect,
}: {
  model: Model
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
}) {
  const update = useUpdateModel(model.id)

  return (
    <Link
      to={`/models/${model.id}`}
      onClick={(e) => {
        if (!selectable) return
        e.preventDefault()
        onToggleSelect?.()
      }}
    >
      <Card
        className={cn(
          "h-full gap-3 py-3 transition-colors hover:border-foreground/20",
          selected && "border-primary ring-2 ring-primary/30",
        )}
      >
        <CardHeader className="relative px-3">
          <ModelThumbnail model={model} />
          {selectable && (
            <Checkbox
              checked={!!selected}
              onCheckedChange={() => onToggleSelect?.()}
              onClick={(e) => e.stopPropagation()}
              aria-label={`Select ${model.title}`}
              className="absolute top-2 left-2 bg-background/80 backdrop-blur-sm"
            />
          )}
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
