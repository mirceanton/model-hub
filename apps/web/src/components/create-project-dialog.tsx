import { Loader2, Plus } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router"
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
import { Textarea } from "@/components/ui/textarea"
import { useCreateProject } from "@/lib/queries"

export function CreateProjectDialog() {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const createProject = useCreateProject()
  const navigate = useNavigate()

  function reset() {
    setTitle("")
    setDescription("")
    createProject.reset()
  }

  function handleSubmit() {
    if (!title.trim()) return
    createProject.mutate(
      { title, description },
      {
        onSuccess: (project) => {
          setOpen(false)
          reset()
          navigate(`/projects/${project.id}`)
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
        New project
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Bundle a set of models pinned to specific commits — like a repo with submodules.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Project name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                handleSubmit()
              }
            }}
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this project? (optional)"
            rows={3}
          />
          {createProject.isError && (
            <p className="text-xs text-destructive">{createProject.error.message}</p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!title.trim() || createProject.isPending}>
            {createProject.isPending && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
