import { Loader2, Plus, X } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "@/components/ui/autocomplete"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { formatBytes } from "@/lib/format"
import { useCreateModel, useTags } from "@/lib/queries"
import { tagBadgeStyle } from "@/lib/tag-colors"

export function CreateModelDialog() {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [sourceUrl, setSourceUrl] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [tagQuery, setTagQuery] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { data: allTags } = useTags()
  const createModel = useCreateModel()
  const navigate = useNavigate()

  const suggestions = useMemo(() => {
    const chosen = new Set(tags.map((t) => t.toLowerCase()))
    return (allTags ?? []).map((t) => t.name).filter((name) => !chosen.has(name.toLowerCase()))
  }, [allTags, tags])

  const trimmedQuery = tagQuery.trim()
  const hasExactMatch = suggestions.some((name) => name.toLowerCase() === trimmedQuery.toLowerCase())
  const items = trimmedQuery && !hasExactMatch ? [...suggestions, trimmedQuery] : suggestions

  function addTag(name: string) {
    const value = name.trim()
    if (!value) return
    setTags((prev) => (prev.some((t) => t.toLowerCase() === value.toLowerCase()) ? prev : [...prev, value]))
    setTagQuery("")
  }

  function removeTag(name: string) {
    setTags((prev) => prev.filter((t) => t !== name))
  }

  function reset() {
    setTitle("")
    setSourceUrl("")
    setTags([])
    setTagQuery("")
    setFiles([])
    createModel.reset()
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  function handleSubmit() {
    if (!title.trim() || files.length === 0) return
    createModel.mutate(
      { title, tags, files, sourceUrl: sourceUrl.trim() || undefined },
      {
        onSuccess: (model) => {
          setOpen(false)
          reset()
          navigate(`/models/${model.id}`)
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="size-4" />
        New model
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New model</DialogTitle>
          <DialogDescription>
            Creates a new directory in your library, initializes a repo, and commits the uploaded
            files.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Model name"
            autoFocus
          />

          <Input
            type="url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="Source URL (optional) — e.g. Thingiverse, Printables…"
          />

          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => {
              const known = (allTags ?? []).find((t) => t.name.toLowerCase() === tag.toLowerCase())
              return (
                <Badge
                  key={tag}
                  variant="outline"
                  className="gap-1 pr-1"
                  style={known ? tagBadgeStyle(known.color) : undefined}
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                    aria-label={`Remove tag ${tag}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              )
            })}
            <Autocomplete
              items={items}
              value={tagQuery}
              autoHighlight
              onValueChange={(value, eventDetails) => {
                if (eventDetails.reason === "item-press") {
                  addTag(value)
                } else {
                  setTagQuery(value)
                }
              }}
            >
              <AutocompleteInput placeholder="Add tag…" onBlur={() => addTag(tagQuery)} />
              <AutocompletePopup>
                <AutocompleteEmpty>No tags yet</AutocompleteEmpty>
                <AutocompleteList>
                  {(item: string) => {
                    const isCreate = !suggestions.includes(item)
                    return (
                      <AutocompleteItem key={item} value={item}>
                        {isCreate ? (
                          <>
                            <Plus className="size-3" />
                            Create tag “{item}”
                          </>
                        ) : (
                          item
                        )}
                      </AutocompleteItem>
                    )
                  }}
                </AutocompleteList>
              </AutocompletePopup>
            </Autocomplete>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".stl,.3mf,.obj,.png,.jpg,.jpeg,.webp,.gif,.pdf"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="text-sm file:mr-3 file:rounded-md file:border file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium"
          />
          {files.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-md border p-2 text-xs text-muted-foreground">
              {files.map((file) => (
                <li key={file.name} className="flex justify-between gap-2">
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0">{formatBytes(file.size)}</span>
                </li>
              ))}
            </ul>
          )}
          {createModel.isError && (
            <p className="text-xs text-destructive">{createModel.error.message}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={!title.trim() || files.length === 0 || createModel.isPending}
          >
            {createModel.isPending && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
