import type { Tag } from "@model-hub/shared"
import { X } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useAddTag, useRemoveTag } from "@/lib/queries"

export function TagEditor({ projectId, tags }: { projectId: number; tags: Tag[] }) {
  const [newTag, setNewTag] = useState("")
  const addTag = useAddTag(projectId)
  const removeTag = useRemoveTag(projectId)

  function handleAdd() {
    const name = newTag.trim()
    if (!name) return
    addTag.mutate(name, { onSuccess: () => setNewTag("") })
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <Badge key={tag.id} variant="outline" className="gap-1 pr-1">
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
      <Input
        value={newTag}
        onChange={(e) => setNewTag(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            handleAdd()
          }
        }}
        onBlur={handleAdd}
        placeholder="Add tag…"
        className="h-6 w-24 border-dashed text-xs"
      />
    </div>
  )
}
