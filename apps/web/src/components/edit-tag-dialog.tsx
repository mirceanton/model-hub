import type { TagWithCount } from "@model-hub/shared"
import { Loader2, Pencil } from "lucide-react"
import { useState } from "react"
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
import { useUpdateTag } from "@/lib/queries"

export function EditTagDialog({ tag }: { tag: TagWithCount }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(tag.name)
  const [color, setColor] = useState(tag.color)
  const updateTag = useUpdateTag(tag.id)

  function handleSubmit() {
    if (!name.trim()) return
    updateTag.mutate(
      { name, color },
      {
        onSuccess: () => setOpen(false),
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        updateTag.reset()
        if (next) {
          setName(tag.name)
          setColor(tag.color)
        }
      }}
    >
      <DialogTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Edit tag ${tag.name}`} />}
      >
        <Pencil className="size-3.5" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit tag</DialogTitle>
          <DialogDescription>Update the tag's name and color.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Tag color"
              className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
            />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tag name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
            />
          </div>
          {updateTag.isError && <p className="text-xs text-destructive">{updateTag.error.message}</p>}
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!name.trim() || updateTag.isPending}>
            {updateTag.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
