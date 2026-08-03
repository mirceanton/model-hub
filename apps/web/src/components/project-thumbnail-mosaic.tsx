import type { Project } from "@model-hub/shared"
import { Boxes } from "lucide-react"
import { thumbnailUrl } from "@/lib/model-loader"
import { cn } from "@/lib/utils"

export function ProjectThumbnailMosaic({
  previewPins,
  pinCount,
  className,
}: {
  previewPins: Project["previewPins"]
  pinCount: number
  className?: string
}) {
  const readyPins = previewPins.filter((p) => p.thumbnailStatus === "ready")
  const overflow = pinCount - previewPins.length

  return (
    <div className={cn("relative aspect-square", className)}>
      <div
        className={cn(
          "grid size-full gap-0.5 overflow-hidden rounded-md border bg-muted/50",
          readyPins.length <= 1 ? "grid-cols-1" : "grid-cols-2",
        )}
      >
        {readyPins.length === 0 ? (
          <div className="flex items-center justify-center">
            <Boxes className="size-8 text-muted-foreground/40" />
          </div>
        ) : (
          readyPins.map((pin) => (
            <img
              key={pin.modelId}
              src={thumbnailUrl(pin.modelId, 0)}
              alt=""
              className="size-full object-cover"
            />
          ))
        )}
      </div>
      {overflow > 0 && (
        <span className="absolute right-1 bottom-1 rounded-full bg-background/90 px-1.5 py-0.5 text-[10px] font-medium shadow-sm">
          +{overflow}
        </span>
      )}
    </div>
  )
}
