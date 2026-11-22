import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color, DoubleSide, DynamicDrawUsage,
  LinearFilter, Mesh, MeshBasicMaterial, OrthographicCamera,
  PlaneGeometry, Scene, SRGBColorSpace, WebGLRenderer,
} from 'three'
import type { Cell, Game, Slide, Transfer } from './game.ts'
import { MaterialSurface, ParticleTiles } from './material-surface.ts'
import { ParticleSurface } from './particle-surface.ts'
import type { Tile } from './material-surface.ts'

type Point = { x: number; y: number }
type Ribbon = { points: Point[]; color: string; width: number }
type Stream = { column: number; targetColumn: number; row: number; targetRow: number; firstDrop: number; lastDrop: number; color: string }
type MeltingTile = { cell: Cell; column: number; row: number; started: number }
type Glide = { columns: number; rows: number; started: number }

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const mix = (from: number, to: number, at: number) => from + (to - from) * at
class GlField {
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(0, 1, 1, 0, 0.1, 50)
  private readonly renderer = new WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' })
  private readonly surfaceMesh: Mesh
  private readonly surfaceTexture: CanvasTexture
  private readonly paths = new BufferGeometry()
  private readonly positions: Float32Array
  private readonly colors: Float32Array
  private readonly color = new Color()
  private height = 0
  private particleSurface?: ParticleSurface
  private readonly canvasMaterial: MeshBasicMaterial

  constructor(surface: HTMLCanvasElement, slotCount: number) {
    this.camera.position.z = 10
    this.surfaceTexture = new CanvasTexture(surface)
    this.surfaceTexture.colorSpace = SRGBColorSpace
    this.surfaceTexture.minFilter = LinearFilter
    this.surfaceTexture.generateMipmaps = false
    this.canvasMaterial = new MeshBasicMaterial({
      map: this.surfaceTexture, transparent: true, depthWrite: false,
    })
    this.surfaceMesh = new Mesh(new PlaneGeometry(1, 1), this.canvasMaterial)
    this.scene.add(this.surfaceMesh)
    // Two strips of up to 12 segments per flow.
    this.positions = new Float32Array(slotCount * 2 * 12 * 6 * 3)
    this.colors = new Float32Array(this.positions.length)
    this.paths.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage))
    this.paths.setAttribute('color', new BufferAttribute(this.colors, 3).setUsage(DynamicDrawUsage))
    const ribbons = new Mesh(this.paths, new MeshBasicMaterial({ vertexColors: true, side: DoubleSide }))
    ribbons.frustumCulled = false
    this.scene.add(ribbons)
  }

  get canvas() { return this.renderer.domElement }

  configureParticles(game: Game) {
    this.particleSurface?.dispose()
    this.particleSurface = undefined
    const gl = this.renderer.getContext()
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    const device = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : ''
    const software = /swiftshader|llvmpipe|softpipe|software rasterizer/i.test(device)
    if (game.material && !software && this.renderer.extensions.has('EXT_color_buffer_float')) {
      this.particleSurface = new ParticleSurface(Object.values(game.level.palette).map(color => color.hex), game.material.cells.length)
    }
    this.surfaceMesh.material = this.particleSurface?.material ?? this.canvasMaterial
    this.canvas.dataset.material = this.particleSurface ? 'gpu' : 'cpu'
  }

  paintSurface(surface: MaterialSurface, tiles: Tile[], particles: boolean) {
    if (this.particleSurface) {
      const canvas = surface.canvas
      this.particleSurface.resize(this.camera.right, this.height, canvas.width, canvas.height)
      this.particleSurface.paint(this.renderer, tiles)
    } else {
      surface.paint(tiles, particles)
      this.surfaceTexture.needsUpdate = true
    }
  }

  resize(width: number, height: number, ratio: number) {
    this.height = height
    this.renderer.setSize(Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio)), false)
    this.surfaceMesh.scale.set(width, height, 1)
    this.surfaceMesh.position.set(width / 2, height / 2, 0)
    this.camera.right = width
    this.camera.top = height
    this.camera.updateProjectionMatrix()
  }

  paint(ribbons: Ribbon[], _surfaceChanged: boolean) {

    let index = 0
    const write = (x: number, y: number) => {
      this.positions[index] = x
      this.colors[index++] = this.color.r
      this.positions[index] = this.height - y
      this.colors[index++] = this.color.g
      this.positions[index] = 1
      this.colors[index++] = this.color.b
    }
    for (const ribbon of ribbons) {
      this.color.set(ribbon.color)
      for (let i = 1; i < ribbon.points.length; i++) {
        const before = ribbon.points[i - 1]
        const after = ribbon.points[i]
        const dx = after.x - before.x
        const dy = after.y - before.y
        const taper = .68 + .32 * Math.sin(Math.PI * i / ribbon.points.length)
        const scale = ribbon.width * taper * 0.5 / (Math.hypot(dx, dy) || 1)
        const nx = dy * scale
        const ny = -dx * scale
        write(before.x + nx, before.y + ny)
        write(before.x - nx, before.y - ny)
        write(after.x + nx, after.y + ny)
        write(after.x + nx, after.y + ny)
        write(before.x - nx, before.y - ny)
        write(after.x - nx, after.y - ny)
      }
    }
    this.paths.setDrawRange(0, index / 3)
    this.paths.getAttribute('position').needsUpdate = true
    this.paths.getAttribute('color').needsUpdate = true
    this.renderer.render(this.scene, this.camera)
  }
}

class CanvasField {
  readonly canvas = document.createElement('canvas')
  private readonly context = this.canvas.getContext('2d')!
  constructor(private readonly surface: HTMLCanvasElement) {}
  private ratio = 1

  resize(width: number, height: number, ratio: number) {
    this.ratio = ratio
    this.canvas.width = Math.max(1, Math.round(width * ratio))
    this.canvas.height = Math.max(1, Math.round(height * ratio))
  }

  configureParticles(_game: Game) {}

  paintSurface(surface: MaterialSurface, tiles: Tile[], particles: boolean) {
    surface.paint(tiles, particles)
  }

  paint(ribbons: Ribbon[]) {
    const context = this.context
    context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0)
    context.clearRect(0, 0, this.canvas.width / this.ratio, this.canvas.height / this.ratio)
    context.drawImage(this.surface, 0, 0, this.canvas.width / this.ratio, this.canvas.height / this.ratio)
    for (const ribbon of ribbons) {
      const [first, ...rest] = ribbon.points
      context.beginPath()
      context.moveTo(first.x, first.y)
      for (const point of rest) context.lineTo(point.x, point.y)
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.strokeStyle = ribbon.color
      context.lineWidth = ribbon.width
      context.stroke()
    }
  }
}

export class Field {
  private painter: GlField | CanvasField
  private particleTiles?: ParticleTiles
  private readonly materialSurface: MaterialSurface
  private palette: Record<string, { base: string; reflection: string }>
  private maxHeight: number
  private offsets: number[]
  private readonly slopes: number[]
  private readonly glides = new Map<number, Glide>()
  private streams = new Map<number, Stream>()
  private melting: MeltingTile[] = []
  private lastFrame = 0
  private sizeKey = ''
  private lastSurfacePaint = -Infinity
  private layout?: { width: number; height: number; left: number; bottom: number; pitch: number; rowHeight: number; slots: Point[] }
  private low = false
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)')

  constructor(
    private readonly wrapper: HTMLElement,
    private readonly surface: HTMLElement,
    private readonly dock: HTMLElement,
    private game: Game,
    private readonly invalidate: () => void,
  ) {
    this.materialSurface = new MaterialSurface(Object.values(game.level.palette).map(color => color.hex))
    this.particleTiles = game.material && new ParticleTiles(game.material, game.level.palette)
    this.maxHeight = Math.max(...game.columns.map(column => column.length))
    this.offsets = game.columns.map(() => 0)
    this.slopes = game.columns.map(() => 0)
    this.palette = Object.fromEntries(Object.entries(game.level.palette).map(([id, entry]) => {
      const base = new Color(entry.hex)
      return [id, {
        base: entry.hex,
        reflection: `#${base.lerp(new Color('#fff1d1'), .55).getHexString()}`,
      }]
    }))
    try {
      this.painter = new GlField(this.materialSurface.canvas, game.slots.length)
      this.painter.configureParticles(game)
      this.painter.canvas.addEventListener('webglcontextlost', event => {
        event.preventDefault()
        this.painter = new CanvasField(this.materialSurface.canvas)
        this.attach('canvas2d')
        this.sizeKey = ''
        this.invalidate()
      }, { once: true })
      this.attach('webgl')
    } catch {
      this.painter = new CanvasField(this.materialSurface.canvas)
      this.attach('canvas2d')
    }
    new ResizeObserver(() => {
      this.layout = undefined
      this.invalidate()
    }).observe(wrapper)
  }

  private attach(name: string) {
    this.wrapper.replaceChildren(this.painter.canvas)
    this.wrapper.dataset.renderer = name
  }

  reset(game: Game) {
    this.game = game
    this.painter.configureParticles(game)
    this.particleTiles = game.material && new ParticleTiles(game.material, game.level.palette)
    this.maxHeight = Math.max(...game.columns.map(column => column.length))
    this.offsets = game.columns.map(() => 0)
    this.slopes.splice(0, this.slopes.length, ...game.columns.map(() => 0))
    this.palette = Object.fromEntries(Object.entries(game.level.palette).map(([id, entry]) => [id, {
      base: entry.hex,
      reflection: `#${new Color(entry.hex).lerp(new Color('#fff1d1'), .55).getHexString()}`,
    }]))
    this.materialSurface.setColors(Object.values(game.level.palette).map(color => color.hex))
    this.sizeKey = ''
    this.layout = undefined
    this.glides.clear()
    this.streams.clear()
    this.melting = []
    this.lastFrame = 0
  }

  setLowQuality(low: boolean) {
    this.low = low
    this.invalidate()
  }

  startFlows(flows: Transfer[], now: number) {
    const grouped = new Map<number, Transfer[]>()
    for (const flow of flows) {
      const { slot, column, cell } = flow
      if (!flow.source && !this.motion.matches) {
        const glide = this.glideOffset(cell.id, now)
        if (!this.low) this.melting.push({
          cell, column: column + (glide?.x ?? 0), row: this.offsets[column] + (glide?.y ?? 0), started: now,
        })
        this.offsets[column]++
      }
      this.glides.delete(cell.id)
      const group = grouped.get(slot) ?? []
      group.push(flow)
      grouped.set(slot, group)
    }
    const travelMs = this.game.timing.transferTicks * this.game.timing.stepMs
    for (const [slot, group] of grouped) {
      const flow = group[Math.floor(group.length / 2)]
      const color = flow.cell.color
      const column = flow.source ? flow.source.x - .5 : flow.column
      const row = flow.source?.y ?? 0
      const stream = this.streams.get(slot)
      if (stream?.color === color && now - stream.lastDrop <= travelMs) {
        stream.targetColumn = column
        stream.targetRow = row
        stream.lastDrop = now
      } else {
        this.streams.set(slot, {
          column, targetColumn: column, row, targetRow: row, firstDrop: now, lastDrop: now, color,
        })
      }
    }
  }

  startSlides(slides: Slide[], now: number) {
    if (this.motion.matches) return
    for (const { cell, from, fromRow, to, toRow } of slides) {
      const previous = this.glideOffset(cell.id, now)
      this.glides.set(cell.id, {
        columns: from - to + (previous?.x ?? 0),
        rows: fromRow + this.offsets[from] - toRow - this.offsets[to] + (previous?.y ?? 0),
        started: now,
      })
    }
  }

  private glideOffset(cellId: number, now: number): Point | undefined {
    const glide = this.glides.get(cellId)
    if (!glide) return undefined
    const progress = clamp((now - glide.started) / 320)
    if (progress >= 1) {
      this.glides.delete(cellId)
      return undefined
    }
    return {
      x: glide.columns * (1 - progress * progress * (3 - 2 * progress)),
      y: glide.rows * (1 - progress * progress),
    }
  }

  paint(now: number): boolean {
    const layoutChanged = !this.layout
    if (layoutChanged) this.measure()
    const { width, height, left, bottom, pitch, rowHeight, slots } = this.layout!
    const ratio = Math.min(window.devicePixelRatio || 1, this.low ? 1 : 1.5)
    const key = `${width}:${height}:${ratio}:${this.low}`
    const resized = key !== this.sizeKey
    if (resized) {
      this.materialSurface.resize(width, height, this.low, !!this.particleTiles)
      this.painter.resize(width, height, ratio)
      this.sizeKey = key
    }
    const frameMs = this.lastFrame ? Math.min(60, now - this.lastFrame) : 16
    this.lastFrame = now
    const { stepMs, transferTicks } = this.game.timing
    const travelMs = stepMs * transferTicks
    const interval = this.game.flowIntervalMs
    const timeScale = interval / stepMs
    const legacy = this.particleTiles ? undefined : this.legacyTiles(now, frameMs, timeScale)
    const ribbons: Ribbon[] = []
    for (const [slot, stream] of this.streams) {
      const tail = clamp((now - stream.lastDrop - interval) / travelMs)
      if (tail >= 1) {
        this.streams.delete(slot)
        continue
      }
      const plate = slots[slot]
      if (!plate) continue
      const ease = 1 - Math.exp(-frameMs / (140 * timeScale))
      stream.column = mix(stream.column, stream.targetColumn, ease)
      stream.row = mix(stream.row, stream.targetRow, ease)
      const startX = left + (stream.column + .5) * pitch
      const startY = bottom - Math.max(2, stream.row * rowHeight)
      const head = this.motion.matches ? 1 : clamp(.05 + (now - stream.firstDrop) / travelMs)
      const segments = this.low ? 5 : 12
      const points = Array.from({ length: segments + 1 }, (_, i) => {
        const t = mix(this.motion.matches ? 0 : tail, head, i / segments)
        const eased = t * t * (3 - 2 * t)
        const sway = this.low || this.motion.matches ? 0
          : Math.sin(t * 8 - now / (83 * timeScale)) * Math.sin(t * Math.PI) * 1.7
        return { x: mix(startX, plate.x, eased) + sway, y: mix(startY, plate.y, t) }
      })
      const shade = this.palette[stream.color]
      ribbons.push({ points, color: shade.base, width: this.low ? 6 : 10 })
      if (!this.low) ribbons.push({
        points: points.map(point => ({ x: point.x - 1.7, y: point.y })),
        color: shade.reflection, width: 1.8,
      })
    }
    const surfaceInterval = this.low ? 50 : 1000 / 30
    const surfaceChanged = !this.particleTiles || layoutChanged || resized ||
      now - this.lastSurfacePaint >= surfaceInterval - 1
    if (surfaceChanged) {
      const tiles = this.particleTiles?.sample(now, left, bottom, pitch, rowHeight, stepMs) ?? legacy!.tiles
      this.painter.paintSurface(this.materialSurface, tiles, this.particleTiles !== undefined)
      this.lastSurfacePaint = now
    }
    this.painter.paint(ribbons, surfaceChanged)
    return legacy?.bending || this.particleTiles?.interpolating(now - surfaceInterval, stepMs) || this.glides.size > 0 || this.streams.size > 0 ||
      this.melting.length > 0 || this.offsets.some(offset => offset > 0)
  }

  private legacyTiles(now: number, frameMs: number, timeScale: number) {
    const { left, bottom, pitch, rowHeight } = this.layout!
    const tiles: Tile[] = []
    this.offsets = this.offsets.map(offset => {
      const next = offset * Math.exp(-frameMs / (84 * timeScale))
      return next < .025 ? 0 : next
    })
    const heights = this.game.columns.map((cells, index) => cells.length + this.offsets[index])
    const ease = 1 - Math.exp(-frameMs / 95)
    let bending = false
    const gap = 0
    for (const [columnIndex, cells] of this.game.columns.entries()) {
      const x = left + columnIndex * pitch
      const offset = this.offsets[columnIndex]
      const height = heights[columnIndex]
      const leftHeight = heights[columnIndex - 1] ?? height
      const rightHeight = heights[columnIndex + 1] ?? height
      const target = Math.max(-.72, Math.min(.72, (leftHeight - rightHeight) * .21))
      const slope = this.motion.matches ? target : mix(this.slopes[columnIndex], target, ease)
      this.slopes[columnIndex] = Math.abs(slope - target) < .008 ? target : slope
      bending ||= this.slopes[columnIndex] !== target
      for (const [row, cell] of cells.entries()) {
        const glide = this.glideOffset(cell.id, now)
        // Anchor the bottom row at its outlet. Upper material leans toward the lower side.
        const bend = this.slopes[columnIndex] * (row / Math.max(1, cells.length - 1)) ** 1.35
        tiles.push({
          x: x + ((glide?.x ?? 0) + bend * .66) * pitch,
          y: bottom - (row + 1 + offset + (glide?.y ?? 0) - Math.abs(bend) * .3) * rowHeight,
          w: pitch - gap, h: rowHeight - gap, shear: bend * .65,
          color: this.palette[cell.color].base,
        })
      }
    }
    this.melting = this.melting.filter(({ cell, column, row, started }) => {
      const progress = clamp((now - started) / (200 * timeScale))
      if (this.low || progress >= 1) return false
      const w = (pitch - gap) * (1 - progress * .8)
      const h = (rowHeight - gap) * (1 - progress)
      tiles.push({
        x: left + (column + .5) * pitch - w / 2,
        y: bottom - (row + .55) * rowHeight * (1 - progress) - h / 2,
        w, h, color: this.palette[cell.color].base,
      })
      return true
    })
    return { tiles, bending }
  }

  private measure() {
    const view = this.wrapper.getBoundingClientRect()
    const surface = this.surface.getBoundingClientRect()
    const inset = 13
    const drawingWidth = Math.max(1, Math.min(surface.width, surface.height) - inset * 2)
    this.layout = {
      width: Math.max(1, view.width),
      height: Math.max(1, view.height),
      left: surface.left - view.left + (surface.width - drawingWidth) / 2,
      bottom: surface.top - view.top + (surface.height + drawingWidth) / 2,
      pitch: drawingWidth / this.game.columns.length,
      rowHeight: drawingWidth / this.maxHeight,
      slots: [...this.dock.children].map(slot => {
        const bounds = slot.getBoundingClientRect()
        return { x: bounds.left - view.left + bounds.width * .5, y: bounds.top - view.top + bounds.height * .3 }
      }),
    }
  }
}
