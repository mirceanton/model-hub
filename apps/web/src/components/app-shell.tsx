import { Box, LogOut } from "lucide-react"
import { createContext, useContext, useEffect, useState } from "react"
import { Link, NavLink, Outlet } from "react-router"
import { Button } from "@/components/ui/button"
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

function UserMenu() {
  const { data } = useAuthMe()
  const logout = useLogout()

  if (!data?.oidcEnabled) return null

  return (
    <div className="flex items-center gap-2">
      {data.user?.name && (
        <span className="hidden text-sm text-muted-foreground sm:inline">{data.user.name}</span>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Log out"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
      >
        <LogOut className="size-4" />
      </Button>
    </div>
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
