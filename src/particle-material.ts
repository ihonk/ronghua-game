import type { Cell } from './game.ts'

import { JsParticleSolver } from './particle-solver-js.ts'
import { SHAPE_OFFSETS, unit } from './particle-solver.ts'
import type { ParticleSolver, ParticleSolverFactory } from './particle-solver.ts'

const SETTLE_TICKS = 30

export type Outlet = { slot: number; x: number; color: string; amount: number }
export type Withdrawal = { slot: number; cell: Cell; x: number; y: number }

export class ParticleMaterial {
  readonly cells: Cell[]
  readonly x: Float32Array
  readonly y: Float32Array
  readonly previousX: Float32Array
  readonly previousY: Float32Array
  readonly alive: Uint8Array
  readonly width: number
  readonly height: number
  private readonly solver: ParticleSolver
  private readonly bottom: Float32Array
  private activeTicks = 0
  private count: number
  private frame = 0

  constructor(columns: readonly Cell[][], createSolver?: ParticleSolverFactory) {
    this.width = columns.length
    this.height = columns.reduce((height, column) => Math.max(height, column.length), 0)
    this.cells = columns.flat()
    const size = this.cells.length
    this.count = size
    this.solver = createSolver?.(size, this.width, this.height) ?? new JsParticleSolver(size, this.width, this.height)
    const { x, y, previousX, previousY, alive, colorIds, bonds } = this.solver.views
    this.x = x
    this.y = y
    this.previousX = previousX
    this.previousY = previousY
    this.alive = alive.fill(1)
    const colors = new Map<string, number>()
    for (const cell of this.cells) {
      if (!colors.has(cell.color)) colors.set(cell.color, colors.size)
      colorIds[cell.id] = colors.get(cell.color)!
    }
    this.bottom = new Float32Array(this.width)
    for (const [column, cells] of columns.entries()) {
      for (const [row, cell] of cells.entries()) {
        this.x[cell.id] = column + .5
        this.y[cell.id] = row + .5
        for (const [index, [dx, dy]] of SHAPE_OFFSETS.entries()) {
          bonds[cell.id * SHAPE_OFFSETS.length + index] = columns[column + dx]?.[row + dy]?.id ?? -1
        }
      }
    }
  }

  get wasmBytes() { return this.solver.wasmBytes ?? 0 }
  get revision() { return this.frame }
  get remaining() { return this.count }
  get moving() { return this.activeTicks > 0 }

  private exposed() {
    this.bottom.fill(Infinity)
    for (let i = 0; i < this.cells.length; i++) {
      if (!this.alive[i] || this.y[i] > 2.25) continue
      const column = Math.floor(this.x[i])
      this.bottom[column] = Math.min(this.bottom[column], this.y[i])
    }
    return this.cells.filter(({ id }) => {
      if (!this.alive[id] || this.y[id] > 2.25) return false
      const x = this.x[id]
      const column = Math.floor(x)
      // A lower sample within half a spacing can obstruct the outlet.
      const adjacent = Math.floor(x + (x - column < .5 ? -.48 : .48))
      const floor = Math.min(this.bottom[column], this.bottom[adjacent] ?? Infinity)
      return this.y[id] < floor + .77
    })
  }

  exposedColors() {
    return new Set(this.exposed().map(cell => cell.color))
  }

  take(outlets: readonly Outlet[]): Withdrawal[] {
    if (!outlets.length || !this.count) return []
    const candidates = this.exposed()
    const pairs = outlets.flatMap((outlet, index) => candidates.flatMap(cell => {
      if (outlet.color !== cell.color) return []
      const distance = Math.abs(outlet.x - this.x[cell.id]) + this.y[cell.id] * .55
      return [{ cell, index, distance }]
    })).sort((a, b) => a.distance - b.distance || a.index - b.index || a.cell.id - b.cell.id)
    const budget = outlets.map(outlet => outlet.amount)
    const removed: Withdrawal[] = []
    for (const { cell, index } of pairs) {
      if (budget[index] <= 0 || !this.alive[cell.id]) continue
      const { id } = cell
      this.alive[id] = 0
      budget[index]--
      this.count--
      removed.push({ slot: outlets[index].slot, cell, x: this.x[id], y: this.y[id] })
    }
    if (removed.length) {
      this.activeTicks = SETTLE_TICKS
      this.releaseNear(removed)
    }
    return removed
  }

  private releaseNear(removed: Withdrawal[]) {
    // Dampen the support immediately above and beside the actual withdrawal.
    // Group nearby removals into a floor map to bound work even with five cups.
    const { heat, velocityX, velocityY } = this.solver.views
    this.bottom.fill(Infinity)
    for (const { x } of removed) this.bottom[Math.floor(x)] = x
    for (let i = 0; i < this.cells.length; i++) {
      const y = this.y[i]
      if (!this.alive[i] || y > 9) continue
      const x = this.x[i]
      const column = Math.floor(x)
      let nearest = Infinity
      let dx = 0
      for (let j = Math.max(0, column - 5); j <= Math.min(this.width - 1, column + 5); j++) {
        const offset = this.bottom[j] - x
        if (Math.abs(offset) >= nearest) continue
        nearest = Math.abs(offset)
        dx = offset
      }
      const weight = unit(1 - Math.sqrt(nearest * nearest + (y * .70) ** 2) / 6)
      heat[i] = Math.max(heat[i], weight)
      velocityX[i] += dx * weight * .115
      velocityY[i] -= weight * .35
    }
  }

  advance() {
    if (!this.moving) return
    this.activeTicks--
    if (!this.count) {
      this.activeTicks = 0
      return
    }
    // Two 25 ms substeps per 50 ms game tick, independent of render cadence.
    this.previousX.set(this.x)
    this.previousY.set(this.y)
    this.solver.advance()
    this.frame++
  }
}
