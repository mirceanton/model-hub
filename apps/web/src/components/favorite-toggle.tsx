import { Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function FavoriteToggle({
  favorite,
  onToggle,
  className,
}: {
  favorite: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={favorite}
      onClick={(e) => {
        // Safe to use inside a card wrapped in a <Link> — stops the click from
        // also triggering navigation.
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }}
      className={className}
    >
      <Star className={cn("size-4", favorite && "fill-amber-400 text-amber-400")} />
    </Button>
  )
}
