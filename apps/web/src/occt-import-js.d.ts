/**
 * Hand-written types for `occt-import-js`, which ships none of its own.
 * Deliberately narrow: only the surface model-mesh.tsx actually uses — creating
 * the WASM engine and reading a STEP file's triangulated meshes out of it.
 */
declare module "occt-import-js" {
  interface OcctImportJsOptions {
    /**
     * Maps emscripten's runtime asset lookups (in practice the 7.6 MB
     * `occt-import-js.wasm`) to a URL this app actually serves. Required under a
     * bundler: the default resolves relative to the *page*, not the JS module.
     */
    locateFile?: (path: string) => string
  }

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
    /** `params` is the optional triangulation config; `null` means the library defaults. */
    ReadStepFile(content: Uint8Array, params: unknown): OcctStepResult
  }

  function occtimportjs(options?: OcctImportJsOptions): Promise<OcctImportJs>
  export default occtimportjs
}