import type { ConfigItem } from "@model-hub/shared"
import { Loader2 } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useClearConfigOverride, useSetConfigOverride } from "@/lib/queries"

const SOURCE_LABELS: Record<ConfigItem["source"], string> = {
  env: "Env var",
  override: "Set here",
  default: "Default",
  unset: "Not set",
}

function SourceBadge({ source }: { source: ConfigItem["source"] }) {
  const variant = source === "env" ? "secondary" : source === "override" ? "default" : "outline"
  return <Badge variant={variant}>{SOURCE_LABELS[source]}</Badge>
}

/**
 * One row in the admin Config viewer — reused by each per-category settings
 * tab (Server, Library & Sync, Thumbnails, Rate Limiting — see admin.tsx's
 * ConfigCategoryTab) and the SSO tab's read-only "OIDC Server Configuration"
 * section. Only renders an edit form when `item.editable` and the value
 * isn't currently coming from an env var (env always wins server-side too —
 * see api/routes/config.ts).
 */
export function ConfigItemRow({ item }: { item: ConfigItem }) {
  const [draft, setDraft] = useState<string | null>(null)
  const setOverride = useSetConfigOverride()
  const clearOverride = useClearConfigOverride()

  const canEdit = item.editable && item.source !== "env"
  const isEditing = draft !== null

  function startEdit() {
    setOverride.reset()
    setDraft(item.source === "override" ? (item.value ?? "") : "")
  }

  function cancelEdit() {
    setOverride.reset()
    setDraft(null)
  }

  function save() {
    if (draft === null || !draft.trim()) return
    setOverride.mutate({ key: item.key, value: draft.trim() }, { onSuccess: () => setDraft(null) })
  }

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="font-mono text-xs text-muted-foreground">{item.key}</span>
          <span className="text-sm font-medium">{item.label}</span>
        </div>
        {!isEditing && (
          <div className="flex items-center gap-2">
            <SourceBadge source={item.source} />
            <span className="max-w-64 truncate text-sm text-muted-foreground">{item.value ?? "—"}</span>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{item.description}</p>

      {canEdit && !isEditing && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={startEdit}>
            {item.source === "override" ? "Edit" : "Set value"}
          </Button>
          {item.source === "override" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => clearOverride.mutate(item.key)}
              disabled={clearOverride.isPending}
            >
              Clear
            </Button>
          )}
        </div>
      )}

      {canEdit && isEditing && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="max-w-xs"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  save()
                }
                if (e.key === "Escape") cancelEdit()
              }}
            />
            <Button size="sm" onClick={save} disabled={!draft.trim() || setOverride.isPending}>
              {setOverride.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
          {setOverride.isError && <p className="text-xs text-destructive">{setOverride.error.message}</p>}
        </div>
      )}
    </li>
  )
}
