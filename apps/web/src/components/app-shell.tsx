import { Box, LayoutDashboard, LogOut, Trash2, User } from "lucide-react"
import { createContext, useContext, useEffect, useState } from "react"
import { Link, NavLink, Outlet } from "react-router"
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
    <nav className="flex items-center gap-1 rounded-lg bg-muted p-[3px]">
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
        {data?.oidcEnabled && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
            <UserMenu />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto px-4 py-6" style={{ maxWidth: mainMaxWidth ?? DEFAULT_MAIN_MAX_WIDTH }}>
        <MainMaxWidthContext.Provider value={setMainMaxWidth}>
          <Outlet />
        </MainMaxWidthContext.Provider>
      </main>
    </div>
  )
}
