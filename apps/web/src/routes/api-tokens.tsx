import type { ApiToken } from "@model-hub/shared"
import { AlertCircle, Check, Copy, Loader2, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
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
import { Skeleton } from "@/components/ui/skeleton"
import { formatDateTime } from "@/lib/format"
import { useApiTokens, useCreateApiToken, useRevokeApiToken } from "@/lib/queries"

const MS_PER_DAY = 86_400_000

/** Shown exactly once, right after creation — the plaintext token is never retrievable again after this dialog closes. */
function CreatedTokenDialog({
  token,
  label,
  onClose,
}: {
  token: string
  label: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable/denied -- the value is still visible and selectable below.
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Token created</DialogTitle>
          <DialogDescription>
            Copy “{label}” now — for your security, it won't be shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={token}
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button variant="outline" size="icon" onClick={handleCopy} aria-label="Copy token">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </Button>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateTokenDialog({ onCreated }: { onCreated: (token: string, label: string) => void }) {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState("")
  const [expiresInDays, setExpiresInDays] = useState("")
  const createToken = useCreateApiToken()

  function reset() {
    setLabel("")
    setExpiresInDays("")
    createToken.reset()
  }

  function handleSubmit() {
    if (!label.trim()) return

    const days = Number(expiresInDays)
    const expiresAt =
      expiresInDays.trim() && Number.isFinite(days) && days > 0
        ? Date.now() + days * MS_PER_DAY
        : undefined

    createToken.mutate(
      { label, expiresAt },
      {
        onSuccess: (created) => {
          setOpen(false)
          onCreated(created.token, created.label)
          reset()
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
        <Plus className="size-3.5" />
        New token
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a personal API token</DialogTitle>
          <DialogDescription>
            Authenticates API requests as you, with your current role. The plaintext value is
            shown only once, right after creation.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Label</span>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. slicer post-processing hook"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleSubmit()
                }
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Expires in (days)</span>
            <Input
              type="number"
              min={1}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              placeholder="Never"
            />
          </div>
          {createToken.isError && (
            <p className="text-xs text-destructive">{createToken.error.message}</p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!label.trim() || createToken.isPending}>
            {createToken.isPending && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function isTokenExpired(token: ApiToken): boolean {
  return token.expiresAt != null && token.expiresAt <= Date.now()
}

function TokenRow({ token }: { token: ApiToken }) {
  const revokeToken = useRevokeApiToken()
  const expired = isTokenExpired(token)

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{token.label}</span>
        <span className="truncate text-xs text-muted-foreground">
          Created {formatDateTime(token.createdAt)}
          {token.lastUsedAt != null && ` · Last used ${formatDateTime(token.lastUsedAt)}`}
          {token.expiresAt != null &&
            ` · ${expired ? "Expired" : "Expires"} ${formatDateTime(token.expiresAt)}`}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {expired && (
          <Badge variant="outline" className="text-muted-foreground">
            Expired
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Revoke ${token.label}`}
          onClick={() => revokeToken.mutate(token.id)}
          disabled={revokeToken.isPending}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  )
}

/**
 * Self-service personal API tokens (issue #60) — every authenticated user
 * manages only their own here; no role gate, since a token can never grant
 * more than its owner's existing role (see api-tokens.ts's guard.ts wiring).
 */
export function ApiTokensPage() {
  const { data: tokens, isPending, isError, error } = useApiTokens()
  const [justCreated, setJustCreated] = useState<{ token: string; label: string } | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">API Tokens</h1>
          <p className="text-sm text-muted-foreground">
            Script against the API without a browser session — send{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              Authorization: Bearer &lt;token&gt;
            </code>
            .
          </p>
        </div>
        <CreateTokenDialog onCreated={(token, label) => setJustCreated({ token, label })} />
      </div>

      {isPending && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      )}

      {isError && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Couldn't load tokens</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {tokens && tokens.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No tokens yet. Create one to script against the API — e.g. a slicer post-processing
          hook that pushes a new model version after every successful print.
        </p>
      )}

      {tokens && tokens.length > 0 && (
        <ul className="flex flex-col divide-y rounded-lg border">
          {tokens.map((token) => (
            <TokenRow key={token.id} token={token} />
          ))}
        </ul>
      )}

      {justCreated && (
        <CreatedTokenDialog
          token={justCreated.token}
          label={justCreated.label}
          onClose={() => setJustCreated(null)}
        />
      )}
    </div>
  )
}
