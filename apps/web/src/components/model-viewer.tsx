import type { ModelExtension } from "@model-hub/shared"
import { Bounds, Html, OrbitControls } from "@react-three/drei"
import { Canvas, useThree } from "@react-three/fiber"
import { AlertTriangle, Loader2 } from "lucide-react"
import { Component, Suspense, useEffect, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { EmptyGeometryError, ModelMesh } from "./model-mesh"

function ViewerLoading() {
  return (
    <Html center>
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </Html>
  )
}

function ViewerMessage({ text }: { text: string }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <AlertTriangle className="size-6" />
      <p className="max-w-56 text-center text-xs">{text}</p>
    </div>
  )
}

class ViewerErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      const text =
        this.state.error instanceof EmptyGeometryError
          ? "This file doesn't contain viewable geometry (some slicer-exported print files omit the mesh)."
          : "Couldn't render this file."
      return <ViewerMessage text={text} />
    }
    return this.props.children
  }
}

/** Hands the live WebGL canvas up to the parent once mounted, so it can be captured on demand (e.g. for a user-posed thumbnail) without threading a ref through react-three-fiber's Canvas. */
function CanvasHandle({ onReady }: { onReady?: (canvas: HTMLCanvasElement) => void }) {
  const canvas = useThree((state) => state.gl.domElement)
  useEffect(() => {
    onReady?.(canvas)
  }, [canvas, onReady])
  return null
}

export function ModelViewer({
  url,
  extension,
  className,
  onCanvasReady,
}: {
  url: string
  extension: ModelExtension
  className?: string
  /** Called once the canvas mounts. `preserveDrawingBuffer` is on, so `canvas.toBlob()` reliably captures whatever is currently rendered. */
  onCanvasReady?: (canvas: HTMLCanvasElement) => void
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border bg-muted/30", className)}>
      <ViewerErrorBoundary key={url}>
        <Canvas
          camera={{ fov: 45, position: [4, 4, 4] }}
          shadows
          dpr={[1, 2]}
          gl={{ preserveDrawingBuffer: true }}
        >
          <CanvasHandle onReady={onCanvasReady} />
          <ambientLight intensity={0.7} />
          <directionalLight position={[5, 10, 7.5]} intensity={1.2} castShadow />
          <directionalLight position={[-5, -5, -5]} intensity={0.3} />
          <Suspense fallback={<ViewerLoading />}>
            <Bounds fit clip observe margin={1.3}>
              <ModelMesh url={url} extension={extension} />
            </Bounds>
          </Suspense>
          <OrbitControls makeDefault enableDamping />
        </Canvas>
      </ViewerErrorBoundary>
    </div>
  )
}
