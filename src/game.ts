import type { Cup, Level } from './level.ts'
import { ParticleMaterial } from './particle-material.ts'
import type { ParticleSolverFactory } from './particle-solver.ts'

const LEGACY_RULES_VERSION = 1
const FIRST_PROGRESSIVE_RULES_VERSION = 2
const HALF_SPEED_RULES_VERSION = 3
const FIRST_SLUMP_RULES_VERSION = 4
const NEAREST_RULES_VERSION = 5
export const RULES_VERSION = 6
export const PARTICLE_RULES_VERSION = 7
export const TIMING = Object.freeze({ stepMs: 50, transferTicks: 12, exitTicks: 8 })
const BASE_POUR_MS = 1500
const SLUMP_HEIGHT_DIFFERENCE = 3
const SLUMP_INTERVAL_TICKS = 2

export type Timing = { stepMs: number; transferTicks: number; exitTicks: number }
export type Outcome = 'playing' | 'won' | 'stuck'
export type Rejection = 'empty' | 'stale' | 'full' | 'finished'
export type Command = { queue: number; expectedCup: string }
export type Input = Command & { tick: number; order: number }
export type Cell = { id: number; color: string }
export type ActiveCup = Cup & { filled: number; reserved: number; releaseAt: number | null }
export type Transfer = { slot: number; column: number; cell: Cell; due: number; source?: { x: number; y: number } }
export type Slide = { cell: Cell; from: number; fromRow: number; to: number; toRow: number }
export type Event =
  | { type: 'put'; input: Input; slot: number }
  | { type: 'reject'; input: Input; reason: Rejection }
  | { type: 'flow'; transfer: Transfer }
  | { type: 'slide'; slide: Slide }
  | { type: 'fill'; id: string; filled: number; capacity: number }
  | { type: 'full'; id: string }
  | { type: 'release'; id: string }
  | { type: 'result'; outcome: 'won' | 'stuck' }

export interface Replay {
  levelId: string
  levelVersion: number
  rulesVersion: number
  timing: Timing
  endTick: number
  inputs: Input[]
}

export class Game {
  readonly level: Level
  readonly columns: Cell[][]
  readonly queues: Cup[][]
  readonly slots: (ActiveCup | null)[]
  readonly timing: Timing
  readonly material?: ParticleMaterial
  private readonly inputs: Input[] = []
  private readonly initial = new Map<string, number>()
  private readonly exited = new Map<string, number>()
  private readonly rulesVersion: number
  private readonly nextDropTicks: number[]
  private readonly dropIntervalTicks: number
  private transfers: Transfer[] = []
  private currentTick = 0
  private nextColumn = 0
  private settling = false
  private result: Outcome = 'playing'

  constructor(level: Level, timing: Timing = TIMING, rulesVersion = RULES_VERSION, createSolver?: ParticleSolverFactory) {
    if (![timing.stepMs, timing.transferTicks, timing.exitTicks].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new Error('节拍应为正整数')
    }
    this.level = level
    this.timing = { ...timing }
    this.rulesVersion = rulesVersion
    this.dropIntervalTicks = rulesVersion <= FIRST_PROGRESSIVE_RULES_VERSION ? 1 : 2
    this.nextDropTicks = Array<number>(level.slotCount).fill(0)
    let id = 0
    this.columns = level.pictureColumnsBottomToTop.map(column => column.map(color => {
      this.initial.set(color, (this.initial.get(color) ?? 0) + 1)
      return { id: id++, color }
    }))
    if (rulesVersion === PARTICLE_RULES_VERSION) {
      if (timing.stepMs !== TIMING.stepMs) throw new Error('二维粒子需要 50 毫秒规则步长')
      this.material = new ParticleMaterial(this.columns, createSolver)
    }
    this.queues = level.cupQueuesFrontToBack.map(queue => queue.map(cup => ({ ...cup })))
    this.slots = Array<ActiveCup | null>(level.slotCount).fill(null)
  }

  get tick() { return this.currentTick }
  get outcome() { return this.result }
  get moving() {
    return this.material?.moving || this.settling || this.transfers.length > 0 || this.slots.some(cup => cup?.releaseAt != null)
  }
  get remaining() {
    return this.material?.remaining ?? this.columns.reduce((total, column) => total + column.length, 0)
  }

  exposedColors() {
    return this.material?.exposedColors() ?? new Set(this.columns.flatMap(column => column[0] ? [column[0].color] : []))
  }

  get flowIntervalMs() { return this.timing.stepMs * this.dropIntervalTicks }

  step(commands: readonly Command[] = []): Event[] {
    this.currentTick++
    const events: Event[] = []
    const pending: Transfer[] = []
    for (const transfer of this.transfers) {
      if (transfer.due > this.tick) {
        pending.push(transfer)
        continue
      }
      const cup = this.slots[transfer.slot]!
      cup.reserved--
      cup.filled++
      events.push({ type: 'fill', id: cup.id, filled: cup.filled, capacity: cup.capacity })
      if (cup.filled === cup.capacity) {
        cup.releaseAt = this.tick + this.timing.exitTicks
        events.push({ type: 'full', id: cup.id })
      }
    }
    this.transfers = pending
    for (const [slot, cup] of this.slots.entries()) {
      if (cup?.releaseAt !== this.tick) continue
      this.exited.set(cup.color, (this.exited.get(cup.color) ?? 0) + cup.filled)
      this.slots[slot] = null
      events.push({ type: 'release', id: cup.id })
    }
    for (const command of commands) {
      const input = { ...command, tick: this.tick, order: this.inputs.length }
      this.inputs.push(input)
      events.push(this.place(input))
    }
    if (this.outcome === 'playing') {
      if (this.material) {
        this.material.advance()
        this.drainParticles(this.material, events)
      } else {
        if (this.rulesVersion === LEGACY_RULES_VERSION) this.drainLegacy(events)
        else if (this.rulesVersion < NEAREST_RULES_VERSION) this.drain(events)
        else this.drainNearest(events)
        if (this.rulesVersion === RULES_VERSION) {
          this.levelSurface(events)
          this.settling = false
        } else if (this.rulesVersion >= FIRST_SLUMP_RULES_VERSION && (this.tick - 1) % SLUMP_INTERVAL_TICKS === 0) {
          this.settling = this.settleBoard(events)
        }
      }
      this.checkResult(events)
    }
    this.assertConservation()
    return events
  }

  private place(input: Input): Event {
    const reject = (reason: Rejection): Event => ({ type: 'reject', input, reason })
    if (this.outcome !== 'playing') return reject('finished')
    const queue = this.queues[input.queue]
    const cup = queue?.[0]
    if (!cup) return reject('empty')
    if (cup.id !== input.expectedCup) return reject('stale')
    const slot = this.slots.indexOf(null)
    if (slot === -1) return reject('full')
    this.slots[slot] = { ...cup, filled: 0, reserved: 0, releaseAt: null }
    this.nextDropTicks[slot] = this.tick
    queue.shift()
    return { type: 'put', input, slot }
  }

  private drainParticles(material: ParticleMaterial, events: Event[]) {
    const stepsPerCup = Math.ceil(BASE_POUR_MS / this.timing.stepMs)
    const outlets = this.slots.flatMap((cup, slot) => {
      if (!cup || this.tick < this.nextDropTicks[slot]) return []
      const amount = Math.min(cup.capacity - cup.filled - cup.reserved, Math.ceil(cup.capacity / stepsPerCup))
      const x = material.width * (slot + .5) / this.slots.length
      return amount > 0 ? [{ slot, x, color: cup.color, amount }] : []
    })
    for (const { slot, cell, x, y } of material.take(outlets)) {
      this.nextDropTicks[slot] = this.tick + this.dropIntervalTicks
      this.addTransfer({ column: Math.floor(x), cell, slot, due: this.tick + this.timing.transferTicks, source: { x, y } }, events)
    }
  }

  private drain(events: Event[]) {
    const stepsPerCup = Math.ceil(BASE_POUR_MS / this.timing.stepMs)
    const budgets = this.slots.map((cup, slot) =>
      cup && this.tick >= this.nextDropTicks[slot] ? Math.ceil(cup.capacity / stepsPerCup) : 0)
    const columnCount = this.columns.length
    // Rotate across the exposed bottom so a wide region sinks across the board.
    let columnsWithoutFlow = 0
    while (columnsWithoutFlow < columnCount) {
      const column = this.nextColumn
      this.nextColumn = (column + 1) % columnCount
      const cell = this.columns[column][0]
      const slot = cell ? this.targetSlot(cell.color) : -1
      if (slot === -1 || budgets[slot] === 0) {
        columnsWithoutFlow++
        continue
      }
      budgets[slot]--
      this.nextDropTicks[slot] = this.tick + this.dropIntervalTicks
      columnsWithoutFlow = 0
      this.releaseMaterial(column, slot, events)
    }
  }

  private drainNearest(events: Event[]) {
    const stepsPerCup = Math.ceil(BASE_POUR_MS / this.timing.stepMs)
    const budgets = this.slots.map((cup, slot) =>
      cup && this.tick >= this.nextDropTicks[slot] ? Math.ceil(cup.capacity / stepsPerCup) : 0)
    // All outlets are on the board bottom. Compare normalized horizontal distance
    // to the actual receiving slot; only exposed cells may enter the stream.
    while (true) {
      let bestColumn = -1
      let bestSlot = -1
      let bestDistance = Infinity
      for (const [slot, cup] of this.slots.entries()) {
        if (!cup || !budgets[slot] || cup.filled + cup.reserved >= cup.capacity) continue
        for (const [column, cells] of this.columns.entries()) {
          if (cells[0]?.color !== cup.color) continue
          // Integer cross-products give deterministic distances and tie breaking.
          const distance = Math.abs((2 * column + 1) * this.slots.length - (2 * slot + 1) * this.columns.length)
          if (distance >= bestDistance) continue
          bestDistance = distance
          bestColumn = column
          bestSlot = slot
        }
      }
      if (bestSlot === -1) break
      budgets[bestSlot]--
      this.nextDropTicks[bestSlot] = this.tick + this.dropIntervalTicks
      this.releaseMaterial(bestColumn, bestSlot, events)
    }
  }

  private drainLegacy(events: Event[]) {
    for (const [column, cells] of this.columns.entries()) {
      while (cells.length) {
        const slot = this.targetSlot(cells[0].color)
        if (slot === -1) break
        this.releaseMaterial(column, slot, events)
      }
    }
  }

  private targetSlot(color: string) {
    return this.slots.findIndex(cup => cup?.color === color && cup.filled + cup.reserved < cup.capacity)
  }

  private releaseMaterial(column: number, slot: number, events: Event[]) {
    const cell = this.columns[column].shift()!
    this.addTransfer({ column, cell, slot, due: this.tick + this.timing.transferTicks }, events)
  }

  private addTransfer(transfer: Transfer, events: Event[]) {
    this.slots[transfer.slot]!.reserved++
    this.transfers.push(transfer)
    events.push({ type: 'flow', transfer })
  }

  private settleBoard(events: Event[]) {
    const used = new Set<number>()
    let moved = false
    for (const [from, column] of this.columns.entries()) {
      if (used.has(from) || column.length < SLUMP_HEIGHT_DIFFERENCE) continue
      let to = -1
      let lowest = column.length - SLUMP_HEIGHT_DIFFERENCE + 1
      for (const neighbor of [from - 1, from + 1]) {
        const height = this.columns[neighbor]?.length
        if (height === undefined || height >= lowest || used.has(neighbor)) continue
        to = neighbor
        lowest = height
      }
      if (to === -1) continue
      const cell = column.pop()!
      this.columns[to].push(cell)
      events.push({ type: 'slide', slide: { cell, from, fromRow: column.length, to, toRow: lowest } })
      used.add(from)
      used.add(to)
      moved = true
    }
    return moved
  }

  private levelSurface(events: Event[]) {
    // Pressure relaxation of a bounded liquid. Feed a deficit from below the
    // nearest higher column, so its overlying picture follows downward as one
    // body. Moving only surface grains would scatter the hat/background across
    // the picture. Color and cell IDs are kept; no material is synthesized.
    while (true) {
      const heights = this.columns.map(column => column.length)
      const lowest = Math.min(...heights)
      const highest = Math.max(...heights)
      if (highest - lowest <= 1) return
      let from = -1, to = -1, distance = Infinity
      for (let target = 0; target < heights.length; target++) {
        if (heights[target] !== lowest) continue
        for (let source = 0; source < heights.length; source++) {
          if (heights[source] <= lowest + 1) continue
          const gap = Math.abs(source - target)
          if (gap >= distance) continue
          from = source; to = target; distance = gap
        }
      }
      const cell = this.columns[from].shift()!
      this.columns[to].unshift(cell)
      events.push({ type: 'slide', slide: { cell, from, fromRow: 0, to, toRow: 0 } })
    }
  }

  private checkResult(events: Event[]) {
    if (this.moving) return
    const hasMaterial = this.remaining > 0
    const hasQueue = this.queues.some(queue => queue.length)
    const hasCup = this.slots.some(cup => cup)
    if (!hasMaterial && !hasQueue && !hasCup) {
      this.result = 'won'
    } else if (hasMaterial && !(hasQueue && this.slots.includes(null))) {
      this.result = 'stuck'
    }
    if (this.result !== 'playing') events.push({ type: 'result', outcome: this.result })
  }

  private assertConservation() {
    const counts = new Map(this.exited)
    const count = (color: string, amount: number) => counts.set(color, (counts.get(color) ?? 0) + amount)
    const { material } = this
    if (material) {
      for (const cell of material.cells) if (material.alive[cell.id]) count(cell.color, 1)
    } else {
      for (const column of this.columns) for (const cell of column) count(cell.color, 1)
    }
    for (const transfer of this.transfers) count(transfer.cell.color, 1)
    for (const cup of this.slots) {
      if (!cup) continue
      if (cup.filled + cup.reserved > cup.capacity) throw new Error(`容量超限：${cup.id}`)
      count(cup.color, cup.filled)
    }
    for (const [color, amount] of this.initial) {
      if (counts.get(color) !== amount) throw new Error(`材料量不守恒：${color}`)
    }
  }

  snapshot() {
    const { material } = this
    const particles = material?.cells.flatMap(cell => material.alive[cell.id]
      ? [{ ...cell, x: material.x[cell.id], y: material.y[cell.id] }] : [])
    const columns = material
      ? Array.from({ length: material.width }, () => [] as NonNullable<typeof particles>)
      : null
    if (columns && particles) {
      for (const cell of particles) columns[Math.floor(cell.x)].push(cell)
      for (const column of columns) column.sort((a, b) => a.y - b.y || a.id - b.id)
    }
    return {
      tick: this.tick,
      outcome: this.outcome,
      columns: (columns ?? this.columns).map(column => column.map(cell => cell.color)),
      ...(particles ? { particles } : {}),
      queues: this.queues.map(queue => queue.map(cup => cup.id)),
      slots: this.slots.map(cup => cup && { ...cup }),
      transfers: this.transfers.map(transfer => ({ slot: transfer.slot, cell: transfer.cell.id, due: transfer.due })),
      exited: Object.fromEntries(this.exited),
    }
  }

  replay(): Replay {
    return {
      levelId: this.level.id,
      levelVersion: this.level.version,
      rulesVersion: this.rulesVersion,
      timing: { ...this.timing },
      endTick: this.tick,
      inputs: this.inputs.map(input => ({ ...input })),
    }
  }
}

export function playReplay(level: Level, replay: Replay) {
  if (level.id !== replay.levelId || level.version !== replay.levelVersion ||
    ![PARTICLE_RULES_VERSION, RULES_VERSION, NEAREST_RULES_VERSION, FIRST_SLUMP_RULES_VERSION, HALF_SPEED_RULES_VERSION, FIRST_PROGRESSIVE_RULES_VERSION, LEGACY_RULES_VERSION].includes(replay.rulesVersion)) {
    throw new Error('回放的关卡或规则版本不匹配')
  }
  if (!Number.isSafeInteger(replay.endTick) || replay.endTick < 0) throw new Error('回放终止步无效')
  const byTick = new Map<number, Command[]>()
  let previousTick = 0
  for (const [index, input] of replay.inputs.entries()) {
    if (!Number.isSafeInteger(input.tick) || input.tick < 1 || input.tick < previousTick ||
        input.tick > replay.endTick || input.order !== index) {
      throw new Error('回放输入顺序或逻辑步无效')
    }
    const commands = byTick.get(input.tick) ?? []
    commands.push({ queue: input.queue, expectedCup: input.expectedCup })
    byTick.set(input.tick, commands)
    previousTick = input.tick
  }
  const game = new Game(level, replay.timing, replay.rulesVersion)
  const events: Event[] = []
  while (game.tick < replay.endTick) {
    for (const event of game.step(byTick.get(game.tick + 1))) events.push(event)
  }
  return { snapshot: game.snapshot(), events }
}
