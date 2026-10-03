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

export function InternalRenderPage() {
  const [params] = useSearchParams()
  const modelId = Number(params.get("modelId"))
  const file = params.get("file")
  const extension = params.get("ext") as ModelExtension | null

  useEffect(() => {
    document.body.style.backgroundColor = "transparent"
  }, [])

  if (
    !Number.isInteger(modelId) ||
    !file ||
    (extension !== "stl" && extension !== "3mf" && extension !== "obj" && extension !== "step" && extension !== "stp")
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