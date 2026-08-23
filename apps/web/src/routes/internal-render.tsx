import type { ModelExtension } from "@model-hub/shared"
import { Bounds } from "@react-three/drei"
import { Canvas, useFrame } from "@react-three/fiber"
import { Component, Suspense, useEffect, useRef, type ReactNode } from "react"
import { useSearchParams } from "react-router"
import { EmptyGeometryError, ModelMesh } from "@/components/model-mesh"
import { fileUrl } from "@/lib/model-loader"

declare global {
  interface Window {
    __modelHubRenderReady?: boolean
    __modelHubRenderError?: string
  }
}

// Bounds' camera-fit is normally animated for a nice UX in the interactive
// viewer; here we want it to settle near-instantly so a fixed frame count is
// enough to guarantee the fit has completed before the screenshot is taken.
const FIT_DURATION_S = 0.001
const READY_AFTER_FRAMES = 5

function ReadySignal() {
  const frameCount = useRef(0)
  useFrame(() => {
    frameCount.current += 1
    if (frameCount.current === READY_AFTER_FRAMES) {
      window.__modelHubRenderReady = true
    }
  })
  return null
}

class RenderErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    window.__modelHubRenderError =
      error instanceof EmptyGeometryError ? "empty-geometry" : (error.message ?? "render-failed")
  }

  render() {
    return this.state.hasError ? null : this.props.children
  }
}

/**
 * Headless-only route: driven by Playwright to screenshot a model for its
 * thumbnail. Not linked from anywhere in the UI. Reuses the same mesh-loading
 * code as the interactive viewer (model-mesh.tsx) so thumbnails always match
 * what's shown in-app.
 */
export function InternalRenderPage() {
  const [params] = useSearchParams()
  const modelId = Number(params.get("modelId"))
  const file = params.get("file")
  const extension = params.get("ext") as ModelExtension | null

  // The app's global `body { @apply bg-background }` paints an opaque,
  // theme-dependent color. This route has no persisted theme preference
  // (fresh Playwright context), so it'd otherwise bake in the "light" default
  // as an opaque square behind every thumbnail. Thumbnails must be
  // transparent so they pick up whichever theme is active when displayed.
  useEffect(() => {
    document.body.style.backgroundColor = "transparent"
  }, [])

  if (
    !Number.isInteger(modelId) ||
    !file ||
    (extension !== "stl" && extension !== "3mf" && extension !== "obj")
  ) {
    window.__modelHubRenderError = "invalid-params"
    return null
  }

  return (
    <div style={{ width: "512px", height: "512px" }}>
      <RenderErrorBoundary>
        <Canvas camera={{ fov: 45, position: [4, 4, 4] }} dpr={1} gl={{ preserveDrawingBuffer: true }}>
          <ambientLight intensity={0.7} />
          <directionalLight position={[5, 10, 7.5]} intensity={1.2} />
          <directionalLight position={[-5, -5, -5]} intensity={0.3} />
          {/*
            ReadySignal must live INSIDE this Suspense boundary, not beside it.
            Suspense commits its whole subtree atomically once the loader
            promise resolves, so nesting it here is what makes the frame count
            only start after the model has actually loaded — as a sibling of
            Suspense it would start counting from Canvas mount instead, racing
            ahead of the (async) model fetch and firing "ready" over a still-
            empty scene.
          */}
          <Suspense fallback={null}>
            <Bounds fit clip margin={1.3} maxDuration={FIT_DURATION_S}>
              <ModelMesh url={fileUrl(modelId, file)} extension={extension} />
            </Bounds>
            <ReadySignal />
          </Suspense>
        </Canvas>
      </RenderErrorBoundary>
    </div>
  )
}
