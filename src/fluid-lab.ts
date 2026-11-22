import { MaterialSurface, ParticleTiles } from './material-surface.ts'
import { ParticleMaterial } from './particle-material.ts'
import { portrait } from './portrait.ts'
import type { ParticleSolverFactory } from './particle-solver.ts'

const STEP_MS = 50
const DOSE = 340
const PAINT_STEP_MS = 1000 / 30

export function mountFluidLab(root: HTMLElement, createSolver?: ParticleSolverFactory) {
  const gameUrl = new URL(location.href)
  gameUrl.searchParams.delete('lab')
  gameUrl.searchParams.set('level', portrait.id)
  document.title = '融画 · 材料实验'
  root.outerHTML = `<main class="playfield fluid-lab">
    <header class="topbar">
      <a class="icon-button" aria-label="返回海风画师">
        <span class="back-icon" aria-hidden="true"></span>
      </a>
      <div class="level-heading"><h1>肖像材料实验</h1></div>
      <button class="icon-button lab-reset" type="button">重置</button>
    </header>
    <section class="table">
      <div class="table-hud"><span id="lab-amount" role="status"></span></div>
      <div class="lab-well" aria-label="海风画师粒子画板"></div>
      <div class="lab-ports">
        <button class="action" type="button" data-port="0">从左侧取青</button>
        <button class="action" type="button" data-port="1">从右侧取青</button>
      </div>
      <p class="hint">每次取料约三秒。重置后可比较另一侧。</p>
    </section>
  </main>`
  document.querySelector<HTMLAnchorElement>('.topbar a')!.href = gameUrl.href

  const surface = new MaterialSurface(Object.values(portrait.palette).map(color => color.hex))
  const board = document.querySelector<HTMLElement>('.lab-well')!
  const amount = document.querySelector<HTMLElement>('#lab-amount')!
  const ports = [...document.querySelectorAll<HTMLButtonElement>('[data-port]')]
  board.append(surface.canvas)
  let material: ParticleMaterial
  let tiles: ParticleTiles
  let animation = 0
  let nextStep = 0
  let nextDraw = 0
  let tick = 0
  let taken = 0
  let target = 0
  let stopAt = 0
  let outlet = 0

  function reset() {
    cancelAnimationFrame(animation)
    let id = 0
    material = new ParticleMaterial(portrait.pictureColumnsBottomToTop.map(column =>
      column.map(color => ({ id: id++, color }))), createSolver)
    board.dataset.solver = material.wasmBytes ? 'wasm' : 'js'
    tiles = new ParticleTiles(material, portrait.palette)
    tick = taken = target = stopAt = nextDraw = 0
    amount.textContent = '材料 100%'
    ports.forEach(port => { port.disabled = false })
    surface.resize(material.width, material.height, false)
    draw(0)
    animation = 0
  }

  function draw(now: number) {
    surface.paint(tiles.sample(now, 0, material.height, 1, 1, STEP_MS), true)
  }

  function frame(now: number) {
    animation = 0
    if (now - nextStep > 250) nextStep = now
    while ((target > taken && tick < stopAt || material.moving) && now >= nextStep) {
      tick++
      if (tick % 2 === 1 && target > taken && tick <= stopAt) {
        taken += material.take([{ slot: outlet, x: material.width * (outlet ? .9 : .1), color: 'T',
          amount: Math.min(12, target - taken) }]).length
        amount.textContent = `材料 ${(100 * material.remaining / material.cells.length).toFixed(1)}% · 已取 ${taken} 份`
      }
      material.advance()
      nextStep += STEP_MS
    }
    if (now >= nextDraw) {
      draw(now)
      nextDraw = now + PAINT_STEP_MS - 1
    }
    const busy = (target > taken && tick < stopAt) || material.moving || tiles.interpolating(now, STEP_MS)
    if (busy) animation = requestAnimationFrame(frame)
    else {
      draw(now)
      const canTake = material.exposedColors().has('T')
      ports.forEach(port => { port.disabled = !canTake })
    }
  }

  ports.forEach((port, index) => port.addEventListener('click', () => {
    outlet = index
    target = taken + DOSE
    stopAt = tick + 72
    ports.forEach(port => { port.disabled = true })
    nextStep = performance.now()
    nextDraw = 0
    animation = requestAnimationFrame(frame)
  }))
  document.querySelector('.lab-reset')!.addEventListener('click', reset)
  reset()
}
