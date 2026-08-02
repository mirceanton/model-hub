import { Box } from "lucide-react"
import type { Project } from "@model-hub/shared"
import { thumbnailUrl } from "@/lib/model-loader"
import { cn } from "@/lib/utils"

export function ProjectThumbnail({
  project,
  className,
}: {
  project: Pick<Project, "id" | "thumbnailStatus" | "title" | "updatedAt">
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex aspect-square items-center justify-center rounded-md border bg-muted/50",
        className,
      )}
    >
      {project.thumbnailStatus === "ready" ? (
        <img
          src={thumbnailUrl(project.id, project.updatedAt)}
          alt={project.title}
          className="size-full rounded-md object-cover"
        />
      ) : (
        <Box className="size-8 text-muted-foreground/40" />
      )}
    </div>
  )
}
