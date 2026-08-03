import { Box } from "lucide-react"
import type { Model } from "@model-hub/shared"
import { thumbnailUrl } from "@/lib/model-loader"
import { cn } from "@/lib/utils"

export function ModelThumbnail({
  model,
  className,
}: {
  model: Pick<Model, "id" | "thumbnailStatus" | "title" | "updatedAt">
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex aspect-square items-center justify-center rounded-md border bg-muted/50",
        className,
      )}
    >
      {model.thumbnailStatus === "ready" ? (
        <img
          src={thumbnailUrl(model.id, model.updatedAt)}
          alt={model.title}
          className="size-full rounded-md object-cover"
        />
      ) : (
        <Box className="size-8 text-muted-foreground/40" />
      )}
    </div>
  )
}
