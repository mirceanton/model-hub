import { Route, Routes } from "react-router"
import { AppShell } from "@/components/app-shell"
import { ProjectDetailPage } from "@/routes/project-detail"
import { ProjectListPage } from "@/routes/project-list"

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<ProjectListPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
      </Route>
    </Routes>
  )
}
