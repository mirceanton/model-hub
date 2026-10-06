import type { ModelExtension } from "@model-hub/shared"
import { useLoader } from "@react-three/fiber"
import occtimportjs from "occt-import-js"
import wasmUrl from "occt-import-js/dist/occt-import-js.wasm?url"
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

/**
 * The OCCT importer is a ~7.6 MB WebAssembly engine that lives in its own
 * `occt-import-js.wasm` file, next to 97 KB of JS glue that fetches it at
 * runtime. That glue resolves the .wasm through emscripten's `locateFile`,
 * whose default is derived from the *page* URL rather than the JS module's
 * URL — and nothing in the bundle references the file, so no bundler can
 * discover it on its own. Importing it with `?url` and pointing `locateFile`
 * at the emitted asset is what makes it load both from the Vite dev server and
 * from the built SPA (the latter is also what the headless thumbnail renderer
 * serves) instead of 404ing on an `<origin>/occt-import-js.wasm` request.
 *
 * The promise is module-level so the engine is instantiated once per page
 * rather than once per model — `useLoader` caches the *result* per URL, not
 * the engine.
 */
let occtPromise: ReturnType<typeof occtimportjs> | undefined
function getOcct() {
  occtPromise ??= occtimportjs({ locateFile: () => wasmUrl })
  return occtPromise
}

class StepLoader extends THREE.Loader {
  override load(
    url: string,
    onLoad: (group: THREE.Group) => void,
    _onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ) {
    getOcct()
      .then(async (occt) => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to fetch STEP file: ${response.status}`)
        const result = occt.ReadStepFile(new Uint8Array(await response.arrayBuffer()), null)

        const group = new THREE.Group()
        for (const stepMesh of result.meshes) {
          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(stepMesh.attributes.position.array, 3),
          )
          // OCCT already triangulated normals for us; only derive them when the
          // mesh came back without any (computeVertexNormals would overwrite the
          // imported ones and smooth away the CAD model's hard edges).
          if (stepMesh.attributes.normal) {
            geometry.setAttribute(
              "normal",
              new THREE.Float32BufferAttribute(stepMesh.attributes.normal.array, 3),
            )
          } else {
            geometry.computeVertexNormals()
          }
          if (stepMesh.index) {
            geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(stepMesh.index.array), 1))
          }
          const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({ color: "#a1a1aa", roughness: 0.5, metalness: 0.1 }),
          )
          mesh.castShadow = true
          mesh.receiveShadow = true
          group.add(mesh)
        }
        onLoad(group)
      })
      .catch((error: unknown) => {
        if (onError) onError(error)
      })
  }
}

function StepModel({ url }: { url: string }) {
  const group = useLoader(StepLoader, url) as THREE.Group
  if (!hasVisibleGeometry(group)) {
    throw new EmptyGeometryError("STEP contains no mesh objects")
  }
  return <primitive object={group} />
}

/** Loads and renders an .stl/.3mf/.obj/.step/.stp file. Must be inside a Suspense boundary + error boundary (throws EmptyGeometryError for geometry-less files). */
export function ModelMesh({ url, extension }: { url: string; extension: ModelExtension }) {
  if (extension === "stl") return <StlMesh url={url} />
  if (extension === "obj") return <ObjModel url={url} />
  if (extension === "3mf") return <ThreeMfModel url={url} />
  return <StepModel url={url} />
}
