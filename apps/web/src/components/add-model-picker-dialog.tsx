import { Loader2, Plus, Search } from "lucide-react"
import { useEffect, useState } from "react"
import { ModelThumbnail } from "@/components/model-thumbnail"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useAddPin, useModels } from "@/lib/queries"

const SEARCH_DEBOUNCE_MS = 250

export function AddModelPickerDialog({
  projectId,
  excludeModelIds,
}: {
  projectId: number
  excludeModelIds: number[]
}) {
  const [open, setOpen] = useState(false)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const addPin = useAddPin(projectId)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  const { data: models, isPending } = useModels({ q: search || undefined })
  const excluded = new Set(excludeModelIds)
  const results = (models?.data ?? []).filter((m) => !excluded.has(m.id))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setSearchInput("")
          setSearch("")
          addPin.reset()
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Plus className="size-4" />
        Add model
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a model to this project</DialogTitle>
          <DialogDescription>
            Pins the model at its current commit — you can re-pin it to a different commit later.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search models…"
              className="pl-8"
            />
          </div>

          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {isPending ? (
              <Loader2 className="mx-auto size-4 animate-spin" />
            ) : results.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">
                {search ? "No models match." : "No models available to add."}
              </p>
            ) : (
              results.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  disabled={addPin.isPending}
                  onClick={() => addPin.mutate({ modelId: model.id })}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
                >
                  <ModelThumbnail model={model} className="size-9 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{model.title}</span>
                </button>
              ))
            )}
          </div>
          {addPin.isError && <p className="text-xs text-destructive">{addPin.error.message}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
