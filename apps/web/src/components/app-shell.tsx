import { Box, Boxes, FolderKanban, LayoutDashboard, LogOut, Trash2, User } from "lucide-react"
import { createContext, useContext, useEffect, useState } from "react"
import { Link, NavLink, Outlet, useLocation } from "react-router"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ThemeToggle } from "@/components/theme-toggle"
import { useAuthMe, useLogout } from "@/lib/queries"
import { cn } from "@/lib/utils"

const DEFAULT_MAIN_MAX_WIDTH = "72rem" // matches the old fixed max-w-6xl

const MainMaxWidthContext = createContext<(width: string | null) => void>(() => {})

/**
 * Lets a route widen the shared <main> beyond the default max-w-6xl, e.g. to
 * fit more grid columns without shrinking existing content. Resets to the
 * default on unmount.
 */
export function useMainMaxWidth(width: string | null) {
  const setWidth = useContext(MainMaxWidthContext)
  useEffect(() => {
    setWidth(width)
    return () => setWidth(null)
  }, [width, setWidth])
}

function TopNav() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "rounded-md px-3 py-1 text-sm font-medium transition-colors",
      isActive ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
    )

  return (
    <nav className="hidden items-center gap-1 rounded-lg bg-muted p-[3px] sm:flex">
      <NavLink to="/models" className={linkClass}>
        Models
      </NavLink>
      <NavLink to="/projects" className={linkClass}>
        Projects
      </NavLink>
    </nav>
  )
}

function TrashLink() {
  return (
    <Button variant="ghost" size="icon" aria-label="Trash" render={<NavLink to="/trash" />}>
      <Trash2 className="size-4" />
    </Button>
  )
}

function AccountMenuItems({
  isAdmin,
  oidcEnabled,
  onLogout,
  loggingOut,
}: {
  isAdmin: boolean
  oidcEnabled: boolean
  onLogout: () => void
  loggingOut: boolean
}) {
  return (
    <>
      <DropdownMenuItem render={<Link to="/profile" />}>
        <User />
        Profile
      </DropdownMenuItem>
      {isAdmin && (
        <DropdownMenuItem render={<Link to="/admin" />}>
          <LayoutDashboard />
          Admin
        </DropdownMenuItem>
      )}
      {oidcEnabled && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onLogout} disabled={loggingOut}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}

function UserMenu() {
  const { data } = useAuthMe()
  const logout = useLogout()
  const isAdmin = data?.user?.role === "admin"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" className="gap-1.5 px-2" />}>
        <User className="size-4" />
        {data?.user?.name && <span className="hidden text-sm sm:inline">{data.user.name}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <AccountMenuItems
          isAdmin={isAdmin}
          oidcEnabled={!!data?.oidcEnabled}
          onLogout={() => logout.mutate()}
          loggingOut={logout.isPending}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BottomNavLink({
  to,
  icon: Icon,
  label,
}: {
  to: string
  icon: typeof Box
  label: string
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition-colors",
          isActive ? "text-foreground" : "text-muted-foreground",
        )
      }
    >
      <Icon className="size-5" />
      {label}
    </NavLink>
  )
}

function BottomNavAccountTab() {
  const { data } = useAuthMe()
  const logout = useLogout()
  const location = useLocation()
  const isAdmin = data?.user?.role === "admin"
  const isActive = location.pathname === "/profile" || location.pathname.startsWith("/admin")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition-colors",
          isActive ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <User className="size-5" />
        Account
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" side="top">
        <AccountMenuItems
          isAdmin={isAdmin}
          oidcEnabled={!!data?.oidcEnabled}
          onLogout={() => logout.mutate()}
          loggingOut={logout.isPending}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background pb-[env(safe-area-inset-bottom)] sm:hidden">
      <BottomNavLink to="/models" icon={Boxes} label="Models" />
      <BottomNavLink to="/projects" icon={FolderKanban} label="Projects" />
      <BottomNavAccountTab />
    </nav>
  )
}

export function AppShell() {
  const [mainMaxWidth, setMainMaxWidth] = useState<string | null>(null)

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="h-14 border-b">
        <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <Box className="size-5" />
            ModelHub
          </Link>
          <TopNav />
          <div className="flex items-center gap-1">
            <TrashLink />
            <div className="hidden sm:block">
              <UserMenu />
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main
        className="mx-auto px-4 pt-6 pb-20 sm:pb-6"
        style={{ maxWidth: mainMaxWidth ?? DEFAULT_MAIN_MAX_WIDTH }}
      >
        <MainMaxWidthContext.Provider value={setMainMaxWidth}>
          <Outlet />
        </MainMaxWidthContext.Provider>
      </main>
      <BottomNav />
    </div>
  )
}
