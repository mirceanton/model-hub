declare module "occt-import-js" {
  interface OcctMeshAttributes {
    position: { array: Float32Array | number[] }
    normal?: { array: Float32Array | number[] }
  }

  interface OcctMesh {
    attributes: OcctMeshAttributes
    index?: { array: number[] }
  }

  interface OcctStepResult {
    meshes: OcctMesh[]
  }

  interface OcctImportJs {
    ReadStepFile(buffer: Uint8Array, params: unknown): OcctStepResult
  }

  function occtimportjs(): Promise<OcctImportJs>
  export default occtimportjs
}