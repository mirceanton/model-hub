import type { Tag } from "@model-hub/shared"
import { Plus, X } from "lucide-react"
import { useMemo, useState } from "react"
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "@/components/ui/autocomplete"
import { Badge } from "@/components/ui/badge"
import { useAddTag, useRemoveTag, useTags } from "@/lib/queries"
import { tagBadgeStyle } from "@/lib/tag-colors"

export function TagEditor({ modelId, tags }: { modelId: number; tags: Tag[] }) {
  const [query, setQuery] = useState("")
  const { data: allTags } = useTags()
  const addTag = useAddTag(modelId)
  const removeTag = useRemoveTag(modelId)

  const suggestions = useMemo(() => {
    const existing = new Set(tags.map((tag) => tag.name.toLowerCase()))
    return (allTags ?? []).map((tag) => tag.name).filter((name) => !existing.has(name.toLowerCase()))
  }, [allTags, tags])

  const trimmed = query.trim()
  const hasExactMatch = suggestions.some((name) => name.toLowerCase() === trimmed.toLowerCase())
  const items = trimmed && !hasExactMatch ? [...suggestions, trimmed] : suggestions

  function handleAdd(name: string) {
    const value = name.trim()
    if (!value) return
    addTag.mutate(value, { onSuccess: () => setQuery("") })
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <Badge key={tag.id} variant="outline" className="gap-1 pr-1" style={tagBadgeStyle(tag.color)}>
          {tag.name}
          <button
            type="button"
            onClick={() => removeTag.mutate(tag.id)}
            className="rounded-full p-0.5 hover:bg-muted-foreground/20"
            aria-label={`Remove tag ${tag.name}`}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <Autocomplete
        items={items}
        value={query}
        autoHighlight
        onValueChange={(value, eventDetails) => {
          if (eventDetails.reason === "item-press") {
            handleAdd(value)
          } else {
            setQuery(value)
          }
        }}
      >
        <AutocompleteInput placeholder="Add tag…" onBlur={() => handleAdd(query)} />
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
  )
}
