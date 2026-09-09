import type { ConfigCategory, ConfigItem, OidcRoleMapping, UserRole } from "@model-hub/shared"
import { AlertCircle, Loader2, Lock, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfigItemRow } from "@/components/config-item-row"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuthMe } from "@/lib/queries"
import {
  useAdminConfig,
  useAdminUsers,
  useCreateRoleMapping,
  useDeleteAdminUser,
  useDeleteRoleMapping,
  useRoleMapping,
  useUpdateRoleMapping,
  useUpdateRoleMappingSettings,
} from "@/lib/queries"
import { StatsTab } from "@/routes/stats"

const ROLE_LABELS: Record<UserRole, string> = { admin: "Admin", editor: "Editor", viewer: "Viewer" }
const ROLE_OPTIONS: UserRole[] = ["admin", "editor", "viewer"]

function RoleBadge({ role }: { role: UserRole }) {
  const variant = role === "admin" ? "default" : role === "editor" ? "secondary" : "outline"
  return <Badge variant={variant}>{ROLE_LABELS[role]}</Badge>
}

/** Shown in place of an edit control for a value force-enforced by an env var — see admin.ts's registerAdminRoutes. */
function LockedBadge({ envVar }: { envVar: string }) {
  return (
    <Badge variant="secondary" className="gap-1" title={`Set via the ${envVar} environment variable`}>
      <Lock className="size-3" />
      {envVar}
    </Badge>
  )
}

function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: UserRole
  onChange: (role: UserRole) => void
  disabled?: boolean
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => v && onChange(v as UserRole)}
      disabled={disabled}
    >
      <SelectTrigger size="sm" aria-label="Role">
        <SelectValue>{(v: string) => ROLE_LABELS[v as UserRole]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ROLE_OPTIONS.map((role) => (
          <SelectItem key={role} value={role}>
            {ROLE_LABELS[role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function UsersTab() {
  const { data: authMe } = useAuthMe()
  const { data: users, isPending, isError, error } = useAdminUsers()
  const deleteUser = useDeleteAdminUser()

  if (isPending) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Couldn't load users</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  if (users.length === 0) {
    return <p className="text-sm text-muted-foreground">No users yet.</p>
  }

  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {users.map((user) => {
        const canDelete = !user.isLocalOwner && user.id !== authMe?.user?.id
        return (
          <li key={user.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">
                {user.name ?? user.email ?? `User #${user.id}`}
              </span>
              {user.email && user.name && (
                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {user.isLocalOwner && (
                <Badge variant="outline" className="text-muted-foreground">
                  Local owner
                </Badge>
              )}
              <RoleBadge role={user.role} />
              {canDelete && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${user.name ?? user.email ?? `user #${user.id}`}`}
                  disabled={deleteUser.isPending}
                  onClick={() => {
                    if (confirm(`Delete ${user.name ?? user.email ?? `user #${user.id}`}? This can't be undone.`)) {
                      deleteUser.mutate(user.id)
                    }
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function AddRoleMappingDialog() {
  const [open, setOpen] = useState(false)
  const [groupName, setGroupName] = useState("")
  const [role, setRole] = useState<UserRole>("viewer")
  const createMapping = useCreateRoleMapping()

  function reset() {
    setGroupName("")
    setRole("viewer")
    createMapping.reset()
  }

  function handleSubmit() {
    if (!groupName.trim()) return
    createMapping.mutate(
      { groupName, role },
      {
        onSuccess: () => {
          setOpen(false)
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
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Plus className="size-3.5" />
        Add mapping
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Map an OIDC group to a role</DialogTitle>
          <DialogDescription>
            Any authenticated user in this group will resolve to the chosen role on their next
            sign-in.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="e.g. 3d-printing-admins"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                handleSubmit()
              }
            }}
          />
          <RoleSelect value={role} onChange={setRole} />
          {createMapping.isError && (
            <p className="text-xs text-destructive">{createMapping.error.message}</p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleSubmit} disabled={!groupName.trim() || createMapping.isPending}>
            {createMapping.isPending && <Loader2 className="size-4 animate-spin" />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MappingRow({ mapping }: { mapping: OidcRoleMapping }) {
  const updateMapping = useUpdateRoleMapping()
  const deleteMapping = useDeleteRoleMapping()
  const locked = mapping.lockedBy != null

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <span className="truncate font-mono text-sm">{mapping.groupName}</span>
      <div className="flex shrink-0 items-center gap-2">
        {locked ? (
          <>
            <RoleBadge role={mapping.role} />
            <LockedBadge envVar={mapping.lockedBy!} />
          </>
        ) : (
          <>
            <RoleSelect
              value={mapping.role}
              onChange={(role) => updateMapping.mutate({ id: mapping.id, role })}
              disabled={updateMapping.isPending}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove mapping for ${mapping.groupName}`}
              onClick={() => deleteMapping.mutate(mapping.id)}
              disabled={deleteMapping.isPending}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </>
        )}
      </div>
    </li>
  )
}

function OidcServerConfigSection() {
  const { data: items, isPending, isError, error } = useAdminConfig()

  if (isPending) {
    return <Skeleton className="h-32 w-full rounded-lg" />
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Couldn't load the OIDC server configuration</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  const ssoItems = items.filter((item) => item.category === "sso")

  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium">OIDC Server Configuration</span>
      <p className="text-xs text-muted-foreground">
        Set via environment variables — see the Config tab for every setting this instance reads.
      </p>
      <ul className="flex flex-col divide-y rounded-lg border">
        {ssoItems.map((item) => (
          <ConfigItemRow key={item.key} item={item} />
        ))}
      </ul>
    </div>
  )
}

function SsoTab() {
  const { data: authMe } = useAuthMe()
  const { data, isPending, isError, error } = useRoleMapping()
  const [groupsClaim, setGroupsClaim] = useState<string | null>(null)
  const updateSettings = useUpdateRoleMappingSettings()

  return (
    <div className="flex flex-col gap-6">
      <OidcServerConfigSection />

      <Separator />

      {isPending ? (
        <Skeleton className="h-48 w-full rounded-lg" />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Couldn't load the role mapping settings</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : (
        <RoleMappingSection
          data={data}
          authMe={authMe}
          groupsClaim={groupsClaim}
          setGroupsClaim={setGroupsClaim}
          updateSettings={updateSettings}
        />
      )}
    </div>
  )
}

function RoleMappingSection({
  data,
  authMe,
  groupsClaim,
  setGroupsClaim,
  updateSettings,
}: {
  data: NonNullable<ReturnType<typeof useRoleMapping>["data"]>
  authMe: ReturnType<typeof useAuthMe>["data"]
  groupsClaim: string | null
  setGroupsClaim: (v: string | null) => void
  updateSettings: ReturnType<typeof useUpdateRoleMappingSettings>
}) {
  const claimValue = groupsClaim ?? data.groupsClaim
  const groupsClaimLocked = data.groupsClaimLockedBy != null
  const defaultRoleLocked = data.defaultRoleLockedBy != null

  return (
    <div className="flex flex-col gap-6">
      <span className="text-sm font-medium">OIDC Group Mapping</span>

      {!authMe?.oidcEnabled && (
        <Alert>
          <AlertCircle />
          <AlertTitle>OIDC isn't configured</AlertTitle>
          <AlertDescription>
            This mapping only takes effect once OIDC login is enabled. It's safe to configure
            ahead of time.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Groups claim</span>
          <p className="text-xs text-muted-foreground">
            The ID token claim your OIDC provider lists group membership under (e.g. "groups" for
            Authelia/Authentik/Keycloak).
          </p>
          {groupsClaimLocked ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm">{data.groupsClaim}</span>
              <LockedBadge envVar={data.groupsClaimLockedBy!} />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                value={claimValue}
                onChange={(e) => setGroupsClaim(e.target.value)}
                className="max-w-xs"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={claimValue === data.groupsClaim || updateSettings.isPending}
                onClick={() =>
                  updateSettings.mutate(
                    { groupsClaim: claimValue },
                    { onSuccess: () => setGroupsClaim(null) },
                  )
                }
              >
                {updateSettings.isPending && <Loader2 className="size-3.5 animate-spin" />}
                Save
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Default role</span>
          <p className="text-xs text-muted-foreground">
            Assigned to an authenticated user whose groups match none of the mappings below.
          </p>
          {defaultRoleLocked ? (
            <div className="flex items-center gap-2">
              <RoleBadge role={data.defaultRole} />
              <LockedBadge envVar={data.defaultRoleLockedBy!} />
            </div>
          ) : (
            <RoleSelect
              value={data.defaultRole}
              onChange={(role) => updateSettings.mutate({ defaultRole: role })}
              disabled={updateSettings.isPending}
            />
          )}
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Group → role mappings</span>
          <AddRoleMappingDialog />
        </div>
        {data.mappings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No mappings yet — every OIDC user gets the default role above.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {data.mappings.map((mapping) => (
              <MappingRow key={mapping.id} mapping={mapping} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const CONFIG_CATEGORY_LABELS: Record<ConfigCategory, string> = {
  library: "Library & Sync",
  server: "Server",
  thumbnails: "Thumbnails",
  sso: "SSO",
  "rate-limiting": "Rate Limiting",
}
const CONFIG_CATEGORY_ORDER: ConfigCategory[] = ["library", "server", "thumbnails", "sso", "rate-limiting"]

function groupByCategory(items: ConfigItem[]): [ConfigCategory, ConfigItem[]][] {
  return CONFIG_CATEGORY_ORDER.map(
    (category): [ConfigCategory, ConfigItem[]] => [category, items.filter((item) => item.category === category)],
  ).filter(([, categoryItems]) => categoryItems.length > 0)
}

function ConfigTab() {
  const { data: items, isPending, isError, error } = useAdminConfig()

  if (isPending) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Couldn't load config</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-muted-foreground">
        Read-only values are set via environment variable. Editable values are saved here and take
        effect after the server restarts.
      </p>
      {groupByCategory(items).map(([category, categoryItems]) => (
        <div key={category} className="flex flex-col gap-3">
          <span className="text-sm font-medium">{CONFIG_CATEGORY_LABELS[category]}</span>
          <ul className="flex flex-col divide-y rounded-lg border">
            {categoryItems.map((item) => (
              <ConfigItemRow key={item.key} item={item} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function AdminPage() {
  const { data: authMe, isPending } = useAuthMe()

  if (isPending) {
    return <Skeleton className="h-64 w-full rounded-lg" />
  }

  if (authMe?.user?.role !== "admin") {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Admins only</AlertTitle>
        <AlertDescription>You don't have permission to view this page.</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Admin</h1>
      <Tabs defaultValue="stats">
        <TabsList>
          <TabsTrigger value="stats">Stats</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="sso">SSO</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
        </TabsList>
        <TabsContent value="stats" className="mt-4">
          <StatsTab />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="sso" className="mt-4">
          <SsoTab />
        </TabsContent>
        <TabsContent value="config" className="mt-4">
          <ConfigTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
