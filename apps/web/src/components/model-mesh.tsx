import type { ModelExtension } from "@model-hub/shared"
import { useLoader } from "@react-three/fiber"
import * as THREE from "three"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js"

/** Thrown when a file parses cleanly but contains no renderable mesh (e.g. some slicer "sliced project" exports omit geometry entirely). */
export class EmptyGeometryError extends Error {}

function hasVisibleGeometry(object: THREE.Object3D): boolean {
  let found = false
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const position = child.geometry?.getAttribute("position")
      if (position && position.count > 0) found = true
    }
  })
  return found
}

function StlMesh({ url }: { url: string }) {
  const geometry = useLoader(STLLoader, url)
  if (!geometry.getAttribute("position")?.count) {
    throw new EmptyGeometryError("STL contains no vertices")
  }
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshStandardMaterial color="#a1a1aa" roughness={0.5} metalness={0.1} />
    </mesh>
  )
}

function ThreeMfModel({ url }: { url: string }) {
  const group = useLoader(ThreeMFLoader, url)
  if (!hasVisibleGeometry(group)) {
    throw new EmptyGeometryError("3MF contains no mesh objects")
  }
  return <primitive object={group} />
}

// .obj files reference materials/textures via a separate .mtl file (mtllib
// directive) that we don't fetch or parse — model-hub only ever uploads/serves
// the single .obj itself. OBJLoader still parses fine without it, just with no
// material, so give every mesh the same neutral material StlMesh uses instead
// of leaving three's undefined-material default (implementation-dependent,
// sometimes invisible under this scene's lighting).
function ObjModel({ url }: { url: string }) {
  const group = useLoader(OBJLoader, url)
  if (!hasVisibleGeometry(group)) {
    throw new EmptyGeometryError("OBJ contains no mesh objects")
  }
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = new THREE.MeshStandardMaterial({ color: "#a1a1aa", roughness: 0.5, metalness: 0.1 })
      child.castShadow = true
      child.receiveShadow = true
    }
  })
  return <primitive object={group} />
}

/** Loads and renders an .stl/.3mf/.obj file. Must be inside a Suspense boundary + error boundary (throws EmptyGeometryError for geometry-less files). */
export function ModelMesh({ url, extension }: { url: string; extension: ModelExtension }) {
  if (extension === "stl") return <StlMesh url={url} />
  if (extension === "obj") return <ObjModel url={url} />
  return <ThreeMfModel url={url} />
}
