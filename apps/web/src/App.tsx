import { lazy, Suspense } from "react"
import { Route, Routes } from "react-router"
import { AppShell } from "@/components/app-shell"
import { ProjectDetailPage } from "@/routes/project-detail"
import { ProjectListPage } from "@/routes/project-list"

// Only ever navigated to by the headless thumbnail worker, never a real user —
// lazy-loaded so its three.js/r3f/drei weight never lands in the main bundle.
const InternalRenderPage = lazy(() =>
  import("@/routes/internal-render").then((m) => ({ default: m.InternalRenderPage })),
)

export default function App() {
  return (
    <Routes>
      <Route
        path="internal/render"
        element={
          <Suspense fallback={null}>
            <InternalRenderPage />
          </Suspense>
        }
      />
      <Route element={<AppShell />}>
        <Route index element={<ProjectListPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
      </Route>
    </Routes>
  )
}
