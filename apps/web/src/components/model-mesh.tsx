import type { ModelExtension } from "@model-hub/shared"
import { useLoader } from "@react-three/fiber"
import * as THREE from "three"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { ThreeMFLoader } from "three/examples/jsm/loaders/3MFLoader.js"
import occtimportjs from "occt-import-js"

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

let _occtPromise: ReturnType<typeof occtimportjs> | undefined

class STEPLoader extends THREE.Loader {
  private async _getOcct() {
    if (!_occtPromise) _occtPromise = occtimportjs()
    return _occtPromise
  }

  override load(
    url: string,
    onLoad: (group: THREE.Group) => void,
    _onProgress?: unknown,
    onError?: unknown,
  ) {
    this._getOcct()
      .then(async (occt) => {
        const resp = await fetch(url)
        if (!resp.ok) throw new Error(`Failed to fetch STEP file: ${resp.status}`)
        const buffer = new Uint8Array(await resp.arrayBuffer())
        const result = occt.ReadStepFile(buffer, null)

        const group = new THREE.Group()
        for (const mesh of result.meshes) {
          const geo = new THREE.BufferGeometry()
          geo.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3),
          )
          if (mesh.attributes.normal) {
            geo.setAttribute(
              "normal",
              new THREE.Float32BufferAttribute(mesh.attributes.normal.array, 3),
            )
          }
          if (mesh.index) {
            geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.index.array), 1))
          }
          geo.computeVertexNormals()
          const m = new THREE.Mesh(
            geo,
            new THREE.MeshStandardMaterial({ color: "#a1a1aa", roughness: 0.5, metalness: 0.1 }),
          )
          m.castShadow = true
          m.receiveShadow = true
          group.add(m)
        }
        onLoad(group)
      })
      .catch((err) => {
        if (onError) (onError as (err: unknown) => void)(err)
      })
  }
}

function StepModel({ url }: { url: string }) {
  const group = useLoader(STEPLoader, url) as THREE.Group
  if (!hasVisibleGeometry(group)) {
    throw new EmptyGeometryError("STEP contains no mesh objects")
  }
  return <primitive object={group} />
}

export function ModelMesh({ url, extension }: { url: string; extension: ModelExtension }) {
  if (extension === "stl") return <StlMesh url={url} />
  if (extension === "obj") return <ObjModel url={url} />
  if (extension === "3mf") return <ThreeMfModel url={url} />
  return <StepModel url={url} />
}