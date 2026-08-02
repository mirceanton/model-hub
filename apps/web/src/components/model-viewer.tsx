import type { ModelExtension } from "@model-hub/shared"
import { Bounds, Html, OrbitControls } from "@react-three/drei"
import { Canvas } from "@react-three/fiber"
import { AlertTriangle, Loader2 } from "lucide-react"
import { Component, Suspense, type ReactNode } from "react"
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

export function ModelViewer({
  url,
  extension,
  className,
}: {
  url: string
  extension: ModelExtension
  className?: string
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border bg-muted/30", className)}>
      <ViewerErrorBoundary key={url}>
        <Canvas camera={{ fov: 45, position: [4, 4, 4] }} shadows dpr={[1, 2]}>
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
