import { makeParticleViews, RADIUS, SHAPE_OFFSETS, unit } from './particle-solver.ts'
import type { ParticleSolver } from './particle-solver.ts'

const RADIUS_SQUARED = RADIUS ** 2
const KERNEL_SLOPE = 4 / RADIUS_SQUARED
const REST_DENSITY = .97 * (1 + 4 * (1 - 1 / RADIUS_SQUARED) ** 2 + 4 * (1 - 2 / RADIUS_SQUARED) ** 2)
const NEIGHBORS = 24

// Use the same operation order and Float32 writes in particle-solver.c.
export class JsParticleSolver implements ParticleSolver {
  readonly views
  private readonly lambda: Float32Array
  private readonly shiftX: Float32Array
  private readonly shiftY: Float32Array
  private readonly correctionX: Float32Array
  private readonly correctionY: Float32Array
  private readonly head: Int32Array
  private readonly next: Int32Array
  private readonly width: number
  private readonly height: number
  private readonly gridWidth: number
  private readonly gridHeight: number
  private readonly nearby: Int32Array
  private readonly nearbyCount: Uint8Array

  constructor(size: number, width: number, height: number) {
    this.width = width
    this.height = height
    this.views = makeParticleViews(size)
    this.lambda = new Float32Array(size)
    this.shiftX = new Float32Array(size)
    this.shiftY = new Float32Array(size)
    this.correctionX = new Float32Array(size)
    this.correctionY = new Float32Array(size)
    this.next = new Int32Array(size)
    this.nearby = new Int32Array(size * NEIGHBORS)
    this.nearbyCount = new Uint8Array(size)
    this.gridWidth = Math.ceil(width / RADIUS)
    this.gridHeight = Math.ceil(height / RADIUS)
    this.head = new Int32Array(this.gridWidth * this.gridHeight)
  }

  advance() {
    this.substep()
    this.substep()
  }

  private substep() {
    const { x, y, velocityX, velocityY, alive, heat, colorIds } = this.views
    const { correctionX, correctionY } = this
    for (let i = 0; i < x.length; i++) {
      if (!alive[i]) continue
      x[i] += Math.max(-.64, Math.min(.64, velocityX[i]))
      y[i] += Math.max(-.78, Math.min(.64, velocityY[i] - .015))
      correctionX[i] = 0
      correctionY[i] = 0
      if (y[i] < 12) heat[i] += (unit((12 - y[i]) / 9) - heat[i]) * .085
    }
    this.contain(true)
    this.findNeighbors()
    for (let iteration = 0; iteration < 2; iteration++) {
      this.computeDensity()
      this.project(iteration === 0)
      this.contain(false)
    }
    // Use total projection displacement in the velocity update, then apply
    // a symmetric local velocity filter (stronger for the same color).
    for (let i = 0; i < x.length; i++) {
      if (!alive[i]) continue
      const oldX = Math.max(-.64, Math.min(.64, velocityX[i]))
      const oldY = Math.max(-.78, Math.min(.64, velocityY[i] - .015))
      velocityX[i] = (oldX + correctionX[i]) * .84
      velocityY[i] = (oldY + correctionY[i]) * .84
    }
    for (let i = 0; i < x.length; i++) {
      if (!alive[i]) continue
      let dx = 0
      let dy = 0
      const end = i * NEIGHBORS + this.nearbyCount[i]
      for (let k = i * NEIGHBORS; k < end; k++) {
        const j = this.nearby[k]
        const rx = x[i] - x[j]
        const ry = y[i] - y[j]
        const kernel = Math.max(0, 1 - (rx * rx + ry * ry) / RADIUS_SQUARED)
        const weight = kernel ** 2 * (colorIds[i] === colorIds[j] ? .11 : .055)
        dx += (velocityX[j] - velocityX[i]) * weight
        dy += (velocityY[j] - velocityY[i]) * weight
      }
      correctionX[i] = dx
      correctionY[i] = dy
    }
    for (let i = 0; i < x.length; i++) {
      velocityX[i] += correctionX[i]
      velocityY[i] += correctionY[i]
    }
  }

  private contain(predicted: boolean) {
    const { x, y, alive } = this.views
    const { correctionX, correctionY } = this
    for (let i = 0; i < x.length; i++) {
      if (!alive[i]) continue
      const cx = Math.max(.5, Math.min(this.width - .5, x[i]))
      const cy = Math.max(.5, Math.min(this.height - .5, y[i]))
      // Remove outward velocity at a wall; leave the tangential component.
      if (!predicted) {
        correctionX[i] += cx - x[i]
        correctionY[i] += cy - y[i]
      } else {
        correctionX[i] = cx - x[i]
        correctionY[i] = cy - y[i]
      }
      x[i] = cx
      y[i] = cy
    }
  }

  private findNeighbors() {
    this.head.fill(-1)
    const { x, y, alive } = this.views
    const { head, next, gridWidth, gridHeight, nearby, nearbyCount } = this
    for (let i = 0; i < x.length; i++) {
      if (!alive[i]) continue
      const bucket = Math.floor(x[i] / RADIUS) + Math.floor(y[i] / RADIUS) * gridWidth
      next[i] = head[bucket]
      head[bucket] = i
    }
    for (let i = 0; i < x.length; i++) {
      if (!alive[i]) continue
      // A skin around the kernel keeps neighbors valid during the two projections.
      const reach = RADIUS + .32
      const minX = Math.max(0, Math.floor((x[i] - reach) / RADIUS))
      const maxX = Math.min(gridWidth - 1, Math.floor((x[i] + reach) / RADIUS))
      const minY = Math.max(0, Math.floor((y[i] - reach) / RADIUS))
      const maxY = Math.min(gridHeight - 1, Math.floor((y[i] + reach) / RADIUS))
      let count = 0
      const offset = i * NEIGHBORS
      for (let row = minY; row <= maxY && count < NEIGHBORS; row++) {
        for (let col = minX; col <= maxX && count < NEIGHBORS; col++) {
          for (let j = head[row * gridWidth + col]; j >= 0 && count < NEIGHBORS; j = next[j]) {
            if (j === i) continue
            const dx = x[i] - x[j]
            const dy = y[i] - y[j]
            if (dx * dx + dy * dy < reach * reach) nearby[offset + count++] = j
          }
        }
      }
      nearbyCount[i] = count
    }
  }

  private computeDensity() {
    const { x, y, alive } = this.views
    const { nearby, nearbyCount, lambda } = this
    for (let i = 0; i < x.length; i++) {
      if (!alive[i]) continue
      let density = 1
      let sumX = 0
      let sumY = 0
      let squared = 0
      const end = i * NEIGHBORS + nearbyCount[i]
      for (let k = i * NEIGHBORS; k < end; k++) {
        const j = nearby[k]
        const dx = x[i] - x[j]
        const dy = y[i] - y[j]
        const kernel = 1 - (dx * dx + dy * dy) / RADIUS_SQUARED
        if (kernel <= 0) continue
        density += kernel * kernel
        const gradient = kernel * KERNEL_SLOPE / REST_DENSITY
        const gx = dx * gradient
        const gy = dy * gradient
        sumX += gx
        sumY += gy
        squared += gx * gx + gy * gy
      }
      lambda[i] = Math.max(0, density / REST_DENSITY - 1) / (squared + sumX * sumX + sumY * sumY + .035)
    }
  }

  private project(keepShape: boolean) {
    const { x, y, alive, colorIds, bonds, heat } = this.views
    const { nearby, nearbyCount, lambda } = this
    for (let i = 0; i < x.length; i++) {
      if (!alive[i]) continue
      let px = 0
      let py = 0
      const end = i * NEIGHBORS + nearbyCount[i]
      for (let k = i * NEIGHBORS; k < end; k++) {
        const j = nearby[k]
        const dx = x[i] - x[j]
        const dy = y[i] - y[j]
        const distanceSquared = dx * dx + dy * dy
        const kernel = 1 - distanceSquared / RADIUS_SQUARED
        if (kernel <= 0) continue
        const pressure = (lambda[i] + lambda[j]) * kernel * KERNEL_SLOPE / REST_DENSITY
        const sameColor = colorIds[i] === colorIds[j]
        const cohesion = distanceSquared > .96 ? (sameColor ? .095 : .038) * kernel * (distanceSquared - .96) : 0
        const separation = Math.max(0, .56 - distanceSquared) * .27
        const weight = pressure + separation - cohesion
        px += dx * weight
        py += dy * weight
      }
      if (keepShape && heat[i] < .97) {
        // Fit the center and its surviving rest neighbors to one local rotation.
        // Overlapping neighborhoods keep upper color features coherent while
        // softened neighborhoods shear as their support moves.
        let count = 1, centerX = 0, centerY = 0, restX = 0, restY = 0
        let dot = 0, cross = 0
        for (let k = 0; k < SHAPE_OFFSETS.length; k++) {
          const j = bonds[i * SHAPE_OFFSETS.length + k]
          if (j < 0 || !alive[j]) continue
          const dx = x[j] - x[i]
          const dy = y[j] - y[i]
          if (dx * dx + dy * dy > 6.25) continue
          const rx = SHAPE_OFFSETS[k][0]
          const ry = SHAPE_OFFSETS[k][1]
          count++
          centerX += dx
          centerY += dy
          restX += rx
          restY += ry
          dot += dx * rx + dy * ry
          cross += dy * rx - dx * ry
        }
        dot -= (centerX * restX + centerY * restY) / count
        cross -= (centerY * restX - centerX * restY) / count
        const norm = Math.sqrt(dot * dot + cross * cross)
        if (norm > .01) {
          const stiffness = .64 * (1 - heat[i]) / count
          px += stiffness * (centerX - (dot * restX - cross * restY) / norm)
          py += stiffness * (centerY - (cross * restX + dot * restY) / norm)
        }
      }
      this.shiftX[i] = Math.max(-.38, Math.min(.38, px))
      this.shiftY[i] = Math.max(-.38, Math.min(.38, py))
    }
    for (let i = 0; i < x.length; i++) {
      if (!alive[i]) continue
      const dx = this.shiftX[i]
      const dy = this.shiftY[i]
      x[i] += dx
      y[i] += dy
      this.correctionX[i] += dx
      this.correctionY[i] += dy
    }
  }
}
