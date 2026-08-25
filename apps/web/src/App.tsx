import { lazy, Suspense } from "react"
import { Navigate, Route, Routes } from "react-router"
import { AppShell } from "@/components/app-shell"
import { AuthGate } from "@/components/auth-gate"
import { AdminPage } from "@/routes/admin"
import { ApiTokensPage } from "@/routes/api-tokens"
import { ModelDetailPage } from "@/routes/model-detail"
import { ModelListPage } from "@/routes/model-list"
import { ProjectDetailPage } from "@/routes/project-detail"
import { ProjectListPage } from "@/routes/project-list"
import { StatsPage } from "@/routes/stats"
import { TrashPage } from "@/routes/trash"

// Only ever navigated to by the headless thumbnail worker, never a real user —
// lazy-loaded so its three.js/r3f/drei weight never lands in the main bundle.
const InternalRenderPage = lazy(() =>
  import("@/routes/internal-render").then((m) => ({ default: m.InternalRenderPage })),
)

export default function App() {
  return (
    <Routes>
      {/*
        Deliberately outside AuthGate: Playwright's headless page has no user
        session (see server/src/auth/internal-token.ts for how its own API
        calls get past the backend guard instead), so gating this route would
        break thumbnail generation the moment OIDC is enabled.
      */}
      <Route
        path="internal/render"
        element={
          <Suspense fallback={null}>
            <InternalRenderPage />
          </Suspense>
        }
      />
      <Route
        element={
          <AuthGate>
            <AppShell />
          </AuthGate>
        }
      >
        <Route index element={<Navigate to="/models" replace />} />
        <Route path="models" element={<ModelListPage />} />
        <Route path="models/:id" element={<ModelDetailPage />} />
        <Route path="projects" element={<ProjectListPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="trash" element={<TrashPage />} />
        <Route path="tokens" element={<ApiTokensPage />} />
        <Route path="stats" element={<StatsPage />} />
        <Route path="admin" element={<AdminPage />} />
      </Route>
    </Routes>
  )
}
