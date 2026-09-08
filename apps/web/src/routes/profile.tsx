import type { UserRole } from "@model-hub/shared"
import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useAuthMe } from "@/lib/queries"
import { ApiTokensPage } from "@/routes/api-tokens"

const ROLE_LABELS: Record<UserRole, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" }

function RoleBadge({ role }: { role: UserRole }) {
  const variant = role === "admin" ? "default" : role === "editor" ? "secondary" : "outline"
  return <Badge variant={variant}>{ROLE_LABELS[role]}</Badge>
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  )
}

export function ProfilePage() {
  const { data, isPending } = useAuthMe()
  const user = data?.user

  if (isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-lg font-semibold">Profile</h1>
        <p className="text-sm text-muted-foreground">Your account details.</p>
      </div>

      <section className="flex flex-col gap-4 rounded-lg border p-4">
        <h2 className="text-sm font-semibold text-muted-foreground">Account</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Username" value={user?.name ?? "—"} />
          <Field label="Email" value={user?.email ?? "—"} />
          <Field label="Role" value={user ? <RoleBadge role={user.role} /> : "—"} />
        </dl>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border p-4">
        <h2 className="text-sm font-semibold text-muted-foreground">OIDC account</h2>
        {data?.oidcEnabled ? (
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Subject" value={<span className="font-mono text-xs">{user?.oidcSubject ?? "—"}</span>} />
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            This instance is running in single-user mode — you're signed in as the local owner,
            not via OIDC.
          </p>
        )}
      </section>

      <ApiTokensPage />
    </div>
  )
}
