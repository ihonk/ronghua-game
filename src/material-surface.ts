import type { ParticleMaterial } from './particle-material.ts'

export type Tile = { x: number; y: number; w: number; h: number; color: string; shear?: number }

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const mix = (from: number, to: number, at: number) => from + (to - from) * at

// Reconstruct one continuous color surface from the moving material samples.
export class MaterialSurface {
  readonly canvas = document.createElement('canvas')
  private readonly context = this.canvas.getContext('2d')!
  private palette: number[][] = []
  private darkInk: number[] = []
  private readonly indices = new Map<string, number>()
  private densities: Float32Array[] = []
  private image!: ImageData
  private scale = 1
  private horizontalKernel = new Float64Array(0)

  constructor(colors: string[]) {
    this.setColors(colors)
  }

  setColors(colors: string[]) {
    this.indices.clear()
    this.palette = colors.map((hex, index) => {
      this.indices.set(hex, index)
      const number = parseInt(hex.slice(1), 16)
      return [number >> 16, (number >> 8) & 255, number & 255]
    })
    this.darkInk = this.palette.map(([r, g, b]) => 1 + .19 * clamp((160 - (.21 * r + .72 * g + .07 * b)) / 100))
  }

  resize(width: number, height: number, low: boolean, particles = false) {
    this.scale = (low ? 120 : particles ? 160 : 192) / width
    this.canvas.width = Math.round(width * this.scale)
    this.canvas.height = Math.round(height * this.scale)
    this.horizontalKernel = new Float64Array(this.canvas.width)
    this.densities = this.palette.map(() => new Float32Array(this.canvas.width * this.canvas.height))
    this.image = this.context.createImageData(this.canvas.width, this.canvas.height)
  }

  paint(samples: Tile[], particles = false) {
    const { width, height } = this.canvas
    const radius = particles ? 1.56 : 1.3
    for (const density of this.densities) density.fill(0)
    for (const tile of samples) {
      const density = this.densities[this.indices.get(tile.color)!]
      const cx = (tile.x + tile.w / 2) * this.scale
      const cy = (tile.y + tile.h / 2) * this.scale
      const rx = Math.max(.5, tile.w * this.scale * radius)
      const ry = Math.max(.5, tile.h * this.scale * radius)
      const x0 = Math.max(0, Math.floor(cx - rx))
      const x1 = Math.min(width - 1, Math.ceil(cx + rx))
      const fringe = tile.shear ? rx * .5 : 0
      const y0 = Math.max(0, Math.floor(cy - ry - fringe))
      const y1 = Math.min(height - 1, Math.ceil(cy + ry + fringe))
      if (particles) {
        // A particle has an axis-aligned kernel. Reuse its horizontal terms
        // across scanlines instead of repeating two divisions for every pixel.
        for (let x = x0; x <= x1; x++) {
          const dx = (x + .5 - cx) / rx
          this.horizontalKernel[x] = dx * dx
        }
        for (let y = y0; y <= y1; y++) {
          const dy = (y + .5 - cy) / ry
          const vertical = dy * dy
          const row = y * width
          for (let x = x0; x <= x1; x++) {
            const distance = this.horizontalKernel[x] + vertical
            if (distance >= 1) continue
            const falloff = 1 - distance
            density[row + x] += falloff * falloff
          }
        }
      } else {
        const shear = tile.shear ?? 0
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dx = (x + .5 - cx) / rx
            const dy = (y + .5 - cy - shear * (x + .5 - cx)) / ry
            const distance = dx * dx + dy * dy
            if (distance >= 1) continue
            // Compact smooth kernel joins neighbors while preserving a rounded free surface.
            const falloff = 1 - distance
            density[y * width + x] += falloff * falloff
          }
        }
      }
    }

    const pixels = this.image.data
    for (let pixel = 0; pixel < width * height; pixel++) {
      let first = 0
      let second = 0
      let winner = 0
      let runner = 0
      let total = 0
      for (let index = 0; index < this.densities.length; index++) {
        const density = this.densities[index][pixel]
        const value = particles ? density * this.darkInk[index] : density
        total += density
        if (value > first) {
          second = first
          runner = winner
          first = value
          winner = index
        } else if (value > second) {
          second = value
          runner = index
        }
      }
      const offset = pixel * 4
      const alpha = particles ? clamp((total - .49) / .30) : clamp((total - .53) / .12)
      if (!alpha) {
        pixels[offset + 3] = 0
        continue
      }
      const main = this.palette[winner]
      const other = this.palette[runner]
      const transition = particles ? (first + second) * .14 : .045
      const blend = second > 0 ? clamp(.5 - (first - second) / (2 * transition)) : 0
      // Light the reconstructed surface edge from the density gradient.
      let above = 0
      if (pixel >= width && total < 1.1) {
        for (const density of this.densities) above += density[pixel - width]
      }
      const shine = total < 1.1 ? Math.max(0, Math.min(.16, (total - above) * .30)) : 0
      const seam = second > .05 ? Math.max(0, 1 - (first - second) / .14) * .07 : 0
      for (let channel = 0; channel < 3; channel++) {
        const color = mix(main[channel], other[channel], blend)
        pixels[offset + channel] = color + (255 - color) * shine - color * seam
      }
      pixels[offset + 3] = Math.round(alpha * 255)
    }
    this.context.putImageData(this.image, 0, 0)
  }
}

export class ParticleTiles {
  private readonly pool: Tile[] = []
  private readonly visible: Tile[] = []
  private revision = 0
  private changedAt = 0

  constructor(private readonly material: ParticleMaterial, palette: Record<string, { hex: string }>) {
    this.pool = material.cells.map(cell => ({ x: 0, y: 0, w: 0, h: 0, color: palette[cell.color].hex }))
  }

  sample(now: number, left: number, bottom: number, pitch: number, rowHeight: number, stepMs: number) {
    const { material } = this
    if (this.revision !== material.revision) {
      this.revision = material.revision
      this.changedAt = now
    }
    const a = this.revision ? clamp((now - this.changedAt) / stepMs) : 1
    this.visible.length = 0
    for (let i = 0; i < material.cells.length; i++) {
      if (!material.alive[i]) continue
      const tile = this.pool[i]
      tile.x = left + (mix(material.previousX[i], material.x[i], a) - .5) * pitch
      tile.y = bottom - (mix(material.previousY[i], material.y[i], a) + .5) * rowHeight
      tile.w = pitch
      tile.h = rowHeight
      this.visible.push(tile)
    }
    return this.visible
  }

  interpolating(now: number, stepMs: number) {
    return this.revision > 0 && now - this.changedAt < stepMs
  }
}
