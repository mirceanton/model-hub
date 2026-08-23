import type { Model, ModelSortField, SortOrder } from "@model-hub/shared"
import { AlertCircle, ChevronLeft, ChevronRight, FolderOpen, Search, Star } from "lucide-react"
import { useEffect, useState } from "react"
import { Link } from "react-router"
import { CreateModelDialog } from "@/components/create-model-dialog"
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
const PER_PAGE_OPTIONS = [12, 24, 48, 96]
const DEFAULT_PER_PAGE = 12

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
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [perPage, setPerPage] = useState(DEFAULT_PER_PAGE)
  const [page, setPage] = useState(1)
  const [sortValue, setSortValue] = useState(DEFAULT_SORT.value)

  const sortOption = SORT_OPTIONS.find((option) => option.value === sortValue) ?? DEFAULT_SORT

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    setPage(1)
  }, [search, activeTag, favoritesOnly, perPage, sortValue])

  const { data: tags, isPending: tagsPending } = useTags()
  const {
    data: models,
    isPending,
    isError,
    error,
  } = useModels({
    q: search || undefined,
    tag: activeTag ?? undefined,
    favorite: favoritesOnly || undefined,
    page,
    perPage,
    sort: sortOption.sort,
    order: sortOption.order,
  })

  const isFiltered = search.trim().length > 0 || activeTag != null || favoritesOnly
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
            value={String(perPage)}
            onValueChange={(value) => setPerPage(Number(value))}
          >
            <SelectTrigger size="sm" aria-label="Items per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PER_PAGE_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option} per page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CreateModelDialog />
      </div>

      <div className="min-w-0 [grid-area:content]">
        {isPending ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
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
        activeTag={activeTag}
        onSelectTag={setActiveTag}
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
