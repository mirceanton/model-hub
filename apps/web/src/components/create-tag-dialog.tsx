import { Loader2, Plus } from "lucide-react"
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
import { useCreateTag } from "@/lib/queries"

export function CreateTagDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const createTag = useCreateTag()

  function reset() {
    setName("")
    createTag.reset()
  }

  function handleSubmit() {
    if (!name.trim()) return
    createTag.mutate(name, {
      onSuccess: () => {
        setOpen(false)
        reset()
      },
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Create tag" />}>
        <Plus className="size-4" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create tag</DialogTitle>
          <DialogDescription>
            Add a new tag to your library. You can apply it to models afterwards.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
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
          {createTag.isError && <p className="text-xs text-destructive">{createTag.error.message}</p>}
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!name.trim() || createTag.isPending}>
            {createTag.isPending && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
