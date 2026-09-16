import { Archive, ArchiveRestore } from "lucide-react"
import { Button } from "@/components/ui/button"

export function ArchiveToggle({
  archived,
  onToggle,
  className,
}: {
  archived: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={archived ? "Unarchive" : "Archive"}
      aria-pressed={archived}
      onClick={(e) => {
        // Safe to use inside a card wrapped in a <Link> — stops the click from
        // also triggering navigation.
        e.preventDefault()
        e.stopPropagation()
        onToggle()
      }}
      className={className}
    >
      {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
    </Button>
  )
}
