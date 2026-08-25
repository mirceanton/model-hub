import type { TagWithCount } from "@model-hub/shared"
import { Loader2, Plus, Tags } from "lucide-react"
import { useState } from "react"
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "@/components/ui/autocomplete"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/** Bulk-add-tag action for the library grid's selection action bar — creates the tag if it doesn't exist yet, same as the single-model TagEditor. */
export function BulkAddTagButton({
  allTags,
  disabled,
  onApply,
}: {
  allTags: TagWithCount[] | undefined
  disabled?: boolean
  onApply: (tagName: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const suggestions = (allTags ?? []).map((t) => t.name)
  const trimmed = query.trim()
  const hasExactMatch = suggestions.some((name) => name.toLowerCase() === trimmed.toLowerCase())
  const items = trimmed && !hasExactMatch ? [...suggestions, trimmed] : suggestions

  function apply(name: string) {
    const value = name.trim()
    if (!value) return
    onApply(value)
    setOpen(false)
    setQuery("")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" disabled={disabled} />}>
        <Tags className="size-3.5" />
        Add tag
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a tag to the selected models</DialogTitle>
          <DialogDescription>Applies to every currently selected model.</DialogDescription>
        </DialogHeader>
        <Autocomplete
          items={items}
          value={query}
          autoHighlight
          onValueChange={(value, eventDetails) => {
            if (eventDetails.reason === "item-press") apply(value)
            else setQuery(value)
          }}
        >
          <AutocompleteInput
            autoFocus
            placeholder="Tag name…"
            className="h-8 w-full"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                apply(query)
              }
            }}
          />
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
        <DialogFooter>
          <Button type="button" onClick={() => apply(query)} disabled={!trimmed}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Bulk-remove-tag action for the library grid's selection action bar — picks from existing tags; a no-op for any selected model that didn't have it, same as the single-model remove-tag route. */
export function BulkRemoveTagButton({
  allTags,
  disabled,
  pending,
  onApply,
}: {
  allTags: TagWithCount[] | undefined
  disabled?: boolean
  pending?: boolean
  onApply: (tagId: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [tagId, setTagId] = useState<string>("")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" disabled={disabled} />}>
        <Tags className="size-3.5" />
        Remove tag
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove a tag from the selected models</DialogTitle>
          <DialogDescription>
            Removes this tag from every currently selected model that has it.
          </DialogDescription>
        </DialogHeader>
        <Select value={tagId} onValueChange={(value) => value && setTagId(value)}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Choose a tag…" />
          </SelectTrigger>
          <SelectContent>
            {(allTags ?? []).map((tag) => (
              <SelectItem key={tag.id} value={String(tag.id)}>
                {tag.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            disabled={!tagId || pending}
            onClick={() => {
              onApply(Number(tagId))
              setOpen(false)
              setTagId("")
            }}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
