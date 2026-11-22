export const RADIUS = 1.85
export const SHAPE_OFFSETS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
export const unit = (value: number) => Math.max(0, Math.min(1, value))

// Keep this order in sync with initialize() in particle-solver.c.
// The renderer and outlet logic read and write these views in either backend.
export function makeParticleViews(size: number, buffer = new ArrayBuffer(size * (4 * (8 + SHAPE_OFFSETS.length) + 1)), base = 0) {
  let offset = base
  function floats() {
    const view = new Float32Array(buffer, offset, size)
    offset += view.byteLength
    return view
  }
  const x = floats()
  const y = floats()
  const previousX = floats()
  const previousY = floats()
  const velocityX = floats()
  const velocityY = floats()
  const heat = floats()
  const colorIds = new Uint32Array(buffer, offset, size)
  offset += colorIds.byteLength
  const bonds = new Int32Array(buffer, offset, size * SHAPE_OFFSETS.length)
  offset += bonds.byteLength
  const alive = new Uint8Array(buffer, offset, size)
  return { x, y, previousX, previousY, velocityX, velocityY, heat, colorIds, bonds, alive }
}

export interface ParticleSolver {
  readonly views: ReturnType<typeof makeParticleViews>
  readonly wasmBytes?: number
  advance(): void
}

export type ParticleSolverFactory = (size: number, width: number, height: number) => ParticleSolver | undefined

interface SolverExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory
  initialize(size: number, width: number, height: number): number
  advance(): void
}

export function createWasmParticleFactory(loadBytes: () => BufferSource): ParticleSolverFactory {
  // Compilation is deferred until the first particle board. Each board owns
  // its instance and memory, so replacing a board also drops its old arena.
  let module: WebAssembly.Module | undefined
  let attempted = false
  return (size, width, height) => {
    try {
      if (!attempted) {
        attempted = true
        module = new WebAssembly.Module(loadBytes())
      }
      if (!module) return undefined
      const { memory, initialize, advance } = new WebAssembly.Instance(module).exports as SolverExports
      const base = initialize(size, width, height)
      if (!base) return undefined
      return {
        views: makeParticleViews(size, memory.buffer, base),
        wasmBytes: memory.buffer.byteLength,
        advance,
      }
    } catch {
      // Blocked or unavailable WASM, invalid module or insufficient memory.
      return undefined
    }
  }
}
