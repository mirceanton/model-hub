import { AlertCircle, ArrowLeft, Loader2, Trash2 } from "lucide-react"
import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { AddModelPickerDialog } from "@/components/add-model-picker-dialog"
import { ProjectPinRow } from "@/components/project-pin-row"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useDeleteProject, useProject, useUpdateProject } from "@/lib/queries"

export function ProjectDetailPage() {
  const params = useParams<{ id: string }>()
  const id = Number(params.id)
  const { data: project, isPending, isError, error } = useProject(id)

  if (isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Couldn't load this project</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <EditableTitle projectId={project.id} title={project.title} />
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
          <DeleteProjectButton projectId={project.id} />
          <AddModelPickerDialog
            projectId={project.id}
            excludeModelIds={project.pins.map((p) => p.modelId)}
          />
        </div>
      </div>

      <EditableDescription projectId={project.id} description={project.description} />

      <Separator />

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Pinned models ({project.pins.length})
        </h2>
        {project.pins.length === 0 ? (
          <p className="text-sm text-muted-foreground">No models pinned yet. Add one to get started.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {project.pins.map((pin) => (
              <ProjectPinRow key={pin.modelId} projectId={project.id} pin={pin} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function EditableTitle({ projectId, title }: { projectId: number; title: string }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const update = useUpdateProject(projectId)

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(title)
          setEditing(true)
        }}
        className="rounded text-left text-xl font-semibold hover:bg-muted/50"
        title="Click to rename"
      >
        {title}
      </button>
    )
  }

  function commit() {
    setEditing(false)
    const trimmed = value.trim()
    if (trimmed && trimmed !== title) {
      update.mutate({ title: trimmed })
    }
  }

  return (
    <Input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit()
        if (e.key === "Escape") {
          setValue(title)
          setEditing(false)
        }
      }}
      className="h-8 max-w-sm text-xl font-semibold"
    />
  )
}

function EditableDescription({
  projectId,
  description,
}: {
  projectId: number
  description: string
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(description)
  const update = useUpdateProject(projectId)

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(description)
          setEditing(true)
        }}
        className="rounded px-1 py-0.5 text-left text-sm text-muted-foreground hover:bg-muted/50"
        title="Click to edit"
      >
        {description || "No description yet. Click to add one."}
      </button>
    )
  }

  function commit() {
    setEditing(false)
    if (value !== description) {
      update.mutate({ description: value })
    }
  }

  return (
    <Textarea
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setValue(description)
          setEditing(false)
        }
      }}
      placeholder="What is this project?"
      rows={3}
    />
  )
}

function DeleteProjectButton({ projectId }: { projectId: number }) {
  const del = useDeleteProject()
  const navigate = useNavigate()

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={del.isPending}
      onClick={() => {
        if (
          !confirm(
            "Delete this project? This only removes the grouping — the models themselves are untouched.",
          )
        ) {
          return
        }
        del.mutate(projectId, { onSuccess: () => navigate("/projects") })
      }}
    >
      {del.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
      Delete
    </Button>
  )
}

function BackLink() {
  return (
    <Link
      to="/projects"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Back to projects
    </Link>
  )
}
