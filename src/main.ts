import { Field } from './field.ts'
import { Game, playReplay } from './game.ts'
import type { Command, Event, Rejection } from './game.ts'
import { legacyTutorial, tutorial } from './tutorial.ts'
import { campaign, canPlayStage } from './campaign.ts'
import { readProgress, writeProgress } from './progress.ts'
import type { Run } from './progress.ts'
import type { ParticleSolverFactory } from './particle-solver.ts'

export function mountGame(createSolver?: ParticleSolverFactory) {
  function element<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T
  }

  const dock = element('dock')
  const queues = element('queues')
  const quality = element<HTMLButtonElement>('quality')
  const hint = element('hint')
  const result = element('result')
  const remaining = element('remaining')
  const meter = element('tide-track')
  const again = element<HTMLButtonElement>('again')
  const settings = element<HTMLDialogElement>('settings-panel')
  const levels = element<HTMLDialogElement>('level-panel')
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const storage = {
    getItem: (key: string) => window.localStorage.getItem(key),
    setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
  }
  const progress = readProgress(storage, campaign)
  const requestedStage = campaign.findIndex(entry => entry.level.id === new URLSearchParams(location.search).get('level'))
  let stageIndex = requestedStage >= 0 && canPlayStage(requestedStage, progress.completed) ? requestedStage : progress.selected
  let stage = campaign[stageIndex]
  let initialAmount = stage.level.pictureColumnsBottomToTop.reduce((sum, column) => sum + column.length, 0)
  let run: Omit<Run, 'result'>
  let runEnded = false
  let clock = performance.now()
  let waiting = false

  function save() {
    element('storage-note').hidden = writeProgress(storage, progress)
  }

  function accrue(now = performance.now()) {
    if (!document.hidden && !settings.open && !levels.open && !runEnded) {
      const delta = Math.max(0, now - clock)
      run.durationMs += delta
      if (waiting) run.waitingMs += delta
    }
    clock = now
  }

  function finishRun(result: Run['result']) {
    if (runEnded) return
    accrue()
    progress.runs.push({ ...run, result })
    progress.runs = progress.runs.slice(-100)
    runEnded = true
    if (result === 'won' && !progress.completed.includes(stage.level.id)) progress.completed.push(stage.level.id)
    save()
  }

  function beginRun() {
    const id = stage.level.id
    const attempt = (progress.attempts[id] ?? 0) + 1
    progress.attempts[id] = attempt
    run = { levelId: id, attempt, durationMs: 0, waitingMs: 0, peakSlots: 0, firstFullMs: null }
    runEnded = false
    waiting = false
    clock = performance.now()
    progress.selected = stageIndex
    const url = new URL(location.href)
    url.searchParams.set('level', stage.level.id)
    try { history.replaceState(null, '', url) } catch { /* Some file viewers restrict URL changes. */ }
    save()
  }
  const messages: Record<Rejection, string> = {
    full: '接料槽满了，等满杯离开。',
    stale: '这只杯子已入场。',
    empty: '这列杯子已用完。',
    finished: '再玩一次就能继续。',
  }

  type FillTween = { from: number; to: number; started: number }

  let game = new Game(stage.level, undefined, stage.rulesVersion, createSolver)
  let frameId = 0
  let nextStep: number | null = null
  let pending: Command[] = []
  const origins = new Map<string, DOMRect>()
  const fills = new Map<string, FillTween>()

  function schedule() {
    if (!frameId) frameId = requestAnimationFrame(frame)
  }

  dock.style.setProperty('--slots', String(game.slots.length))
  queues.style.setProperty('--columns', String(game.queues.length))
  queues.style.setProperty('--depth', String(Math.max(...game.queues.map(queue => queue.length))))

  const slots = game.slots.map(() => {
    const slot = document.createElement('div')
    slot.className = 'slot'
    slot.setAttribute('role', 'img')
    dock.append(slot)
    return slot
  })

  function buildQueues() {
    queues.replaceChildren()
    queues.style.setProperty('--columns', String(game.queues.length))
    const depth = Math.min(3, Math.max(...game.queues.map(queue => queue.length)))
    queues.style.setProperty('--depth', String(depth))
    element('playfield').style.setProperty('--rear-space', depth > 2 ? '38px' : '0px')
    return game.queues.map((_, index) => {
      const name = String.fromCharCode(65 + index)
      const lane = document.createElement('div')
      const head = document.createElement('button')
      lane.className = 'queue'
      head.type = 'button'
      head.className = 'head'
      lane.append(head)
      queues.append(lane)
      head.addEventListener('click', () => {
        accrue()
        const expectedCup = head.dataset.cup
        if (!expectedCup) return
        const icon = head.firstElementChild
        origins.set(expectedCup, (icon ?? head).getBoundingClientRect())
        pending.push({ queue: index, expectedCup })
        schedule()
      })
      return { head, lane, name }
    })
  }

  let queueViews = buildQueues()

  const coach = document.createElement('span')
  coach.className = 'coach'
  coach.textContent = '点这里放杯'
  coach.setAttribute('aria-hidden', 'true')

  const field = new Field(element('view'), element('surface'), dock, game, schedule)

  function cupIcon(color: string, variant = '') {
    const info = game.level.palette[color]
    const cup = document.createElement('span')
    const body = document.createElement('span')
    const mark = document.createElement('span')
    cup.className = variant ? `cup cup--${variant}` : 'cup'
    cup.style.setProperty('--cup-color', info.hex)
    cup.setAttribute('aria-hidden', 'true')
    body.className = 'cup-body'
    cup.append(body, mark)
    if (variant === 'active') {
      const fill = document.createElement('span')
      fill.className = 'cup-liquid'
      body.append(fill)
      mark.className = 'progress'
      mark.textContent = '0%'
    } else {
      mark.className = 'cup-mark'
      mark.textContent = info.mark
    }
    return cup
  }

  function renderQueues() {
    for (const [index, { head, lane, name }] of queueViews.entries()) {
      const [cup, ...following] = game.queues[index]
      head.disabled = !cup || game.outcome !== 'playing'
      if ((head.dataset.cup ?? '') === (cup?.id ?? '') && head.hasAttribute('aria-label')) continue

      const previous = lane.querySelector<HTMLElement>('.queue-next')
      const from = cup && previous?.dataset.cup === cup.id ? previous.firstElementChild?.getBoundingClientRect() : undefined
      head.replaceChildren()
      for (const preview of lane.querySelectorAll('.queue-next')) preview.remove()
      if (cup) {
        const icon = cupIcon(cup.color)
        head.dataset.cup = cup.id
        head.setAttribute('aria-label', `${name} 队列，${game.level.palette[cup.color].name}`)
        head.append(icon)
        if (from && !motion.matches) {
          const to = icon.getBoundingClientRect()
          icon.animate([
            { transform: `translateY(${from.top - to.top}px) scale(${from.width / to.width})`, opacity: .62 },
            { transform: 'none', opacity: 1 },
          ], { duration: 230, easing: 'cubic-bezier(.19,.72,.32,1)' })
        }
      } else {
        delete head.dataset.cup
        head.setAttribute('aria-label', `${name} 队列已用完`)
      }
      for (const front of following.slice(0, 2)) {
        const next = document.createElement('div')
        next.className = 'queue-next'
        next.dataset.cup = front.id
        next.setAttribute('aria-label', `后排：${game.level.palette[front.color].name}`)
        next.append(cupIcon(front.color, 'next'))
        lane.append(next)
      }
    }
  }

  function renderDock() {
    for (const [index, slot] of slots.entries()) {
      const cup = game.slots[index]
      if (!cup) {
        if (slot.firstChild) slot.replaceChildren()
        delete slot.dataset.id
        delete slot.dataset.flowing
        slot.setAttribute('aria-label', `槽位 ${index + 1}，空`)
        continue
      }
      if (slot.dataset.id !== cup.id) {
        const body = document.createElement('div')
        body.className = 'slot-cup'
        body.append(cupIcon(cup.color, 'active'))
        slot.dataset.id = cup.id
        slot.replaceChildren(body)
      }
      const body = slot.firstElementChild as HTMLElement
      body.classList.toggle('slot-cup--full', cup.releaseAt !== null)
      slot.toggleAttribute('data-flowing', cup.reserved > 0)
      const percent = Math.floor(cup.filled / cup.capacity * 100)
      slot.setAttribute('aria-label', `槽位 ${index + 1}，${game.level.palette[cup.color].name}，${percent}%`)
    }
  }

  function visualAmount(cupId: string, now: number) {
    const fill = fills.get(cupId)
    if (!fill) return 0
    const fraction = Math.min(1, Math.max(0, (now - fill.started) / game.flowIntervalMs))
    return fill.from + (fill.to - fill.from) * fraction
  }

  function paintFill(now: number) {
    let animating = false
    for (const [index, cup] of game.slots.entries()) {
      if (!cup) continue
      const view = slots[index]
      const ratio = (motion.matches ? cup.filled : visualAmount(cup.id, now)) / cup.capacity
      const liquid = view.querySelector<HTMLElement>('.cup-liquid')!
      const progress = view.querySelector('.progress')!
      const percent = `${Math.floor(ratio * 100)}%`
      liquid.style.transform = `scaleY(${ratio})`
      if (progress.textContent !== percent) progress.textContent = percent
      const fill = fills.get(cup.id)
      if (!motion.matches && fill && now - fill.started < game.flowIntervalMs) animating = true
    }
    return animating
  }

  function updateUI(rejection?: Rejection) {
    renderQueues()
    renderDock()
    const amount = game.remaining
    const percent = Math.round(amount / initialAmount * 100)
    remaining.textContent = `${percent}%`
    meter.setAttribute('aria-valuenow', String(percent))
    meter.style.setProperty('--remaining', String(amount / initialAmount))

    const firstAction = game.tick === 0
    queueViews[stage.coachQueue].lane.toggleAttribute('data-coach', firstAction)
    hint.classList.toggle('coached', firstAction)
    coach.textContent = stage.coach
    if (firstAction) queueViews[stage.coachQueue].lane.append(coach)
    else coach.remove()

    if (game.outcome === 'playing') {
      result.hidden = true
      const exposed = game.exposedColors()
      const hasWaitingCup = game.slots.some(cup => cup && cup.releaseAt === null && cup.reserved === 0 && !exposed.has(cup.color))
      const message = rejection ? messages[rejection]
        : firstAction ? '点亮起的杯子。'
        : hasWaitingCup ? '同色材料露出后，杯子会继续装填。'
        : exposed.size === 1 ? `底部露出 ${game.level.palette[[...exposed][0]].name}`
        : exposed.size ? '点杯，让同色材料流进去。' : '等最后的杯子装满。'
      if (hint.textContent !== message) hint.textContent = message
    } else {
      const won = game.outcome === 'won'
      element('result-mark').textContent = won ? '✦' : '◇'
      element('result-title').textContent = won ? '通关！' : '接料槽堵住了'
      finishRun(won ? 'won' : 'stuck')
      element('result-detail').textContent = won ? `${stage.name}的颜色都收齐了。` : '留出空槽，换个顺序再试。'
      element('run-stats').textContent = `${Math.round(run.durationMs / 1000)} 秒 · 第 ${run.attempt} 次尝试 · 最多占用 ${run.peakSlots} 槽`
      const next = element<HTMLButtonElement>('next')
      next.hidden = !won
      next.textContent = stageIndex < campaign.length - 1 ? '下一关' : '返回关卡'
      again.textContent = won ? '重玩本关' : '再试一次'
      renderLevels()
      hint.textContent = ''
      result.hidden = false
      if (!settings.open && !levels.open) again.focus({ preventScroll: true })
    }
  }

  function apply(events: Event[], now: number) {
    if (!events.length) return
    const flows = events.flatMap(event => event.type === 'flow' ? [event.transfer] : [])
    accrue(now)
    run.peakSlots = Math.max(run.peakSlots, game.slots.filter(Boolean).length)
    if (game.slots.every(Boolean) && run.firstFullMs === null) run.firstFullMs = run.durationMs
    waiting = game.slots.some(cup => cup && cup.releaseAt === null && cup.reserved === 0 && cup.filled < cup.capacity)
    field.startFlows(flows, now)
    field.startSlides(events.flatMap(event => event.type === 'slide' ? [event.slide] : []), now)
    const received = new Map<string, number>()
    for (const event of events) {
      if (event.type === 'fill') received.set(event.id, event.filled)
      if (event.type === 'release') fills.delete(event.id)
    }
    for (const [id, to] of received) {
      fills.set(id, { from: visualAmount(id, now), to, started: now })
    }
    const rejection = events.find(event => event.type === 'reject')?.reason
    updateUI(rejection)
    for (const event of events) {
      if (event.type !== 'put' || motion.matches) continue
      const origin = origins.get(event.input.expectedCup)
      const target = slots[event.slot].firstElementChild
      const icon = target?.firstElementChild
      if (!origin || !target || !icon) continue
      const bounds = icon.getBoundingClientRect()
      const dx = origin.x + (origin.width - bounds.width) / 2 - bounds.x
      const dy = origin.y + (origin.height - bounds.height) / 2 - bounds.y
      target.animate([
        { transform: `translate(${dx}px,${dy}px) scale(${origin.width / bounds.width})` },
        { transform: `translate(${dx * .21}px,-9px) scale(1.07)`, offset: .72 },
        { transform: 'none' },
      ], { duration: 230, easing: 'cubic-bezier(.27,.68,.36,1)' })
    }
    origins.clear()
  }

  function frame(now: number) {
    frameId = 0
    if (document.hidden || settings.open || levels.open) return
    if (pending.length || game.moving) {
      if (nextStep === null) nextStep = now
      // Treat a prolonged browser stall like a pause rather than racing animations to catch up.
      if (now - nextStep > 250) nextStep = now
      let steps = 0
      while (now >= nextStep && (pending.length || game.moving)) {
        const commands = pending
        pending = []
        const events = game.step(commands)
        apply(events, now)
        if (game.material && !game.moving && !events.length) updateUI()
        nextStep += game.timing.stepMs
        steps++
        // Keep input and painting responsive on a slow device. Preserve every
        // simulation tick, spreading overdue particle work across frames.
        if (game.material && steps === 1) {
          nextStep = Math.max(nextStep, now)
          break
        }
      }
    }
    if (!pending.length && !game.moving) nextStep = null
    const filling = paintFill(now)
    const flowing = field.paint(now)
    if (filling || flowing || pending.length || game.moving) schedule()
  }

  function restart(index = stageIndex) {
    finishRun(index === stageIndex ? 'restart' : 'left')
    if (frameId) cancelAnimationFrame(frameId)
    frameId = 0
    nextStep = null
    pending = []
    origins.clear()
    fills.clear()
    stageIndex = index
    stage = campaign[index]
    game = new Game(stage.level, undefined, stage.rulesVersion, createSolver)
    initialAmount = stage.level.pictureColumnsBottomToTop.reduce((sum, column) => sum + column.length, 0)
    field.reset(game)
    queueViews = buildQueues()
    for (const slot of slots) {
      slot.replaceChildren()
      delete slot.dataset.id
    }
    beginRun()
    element('level-no').textContent = `融画 · 第 ${stageIndex + 1} 关`
    element('stage-title').textContent = stage.name
    document.title = `融画 · ${stage.name}`
    element('game-table').setAttribute('aria-label', `${stage.name}游戏区`)
    updateUI()
    schedule()
  }

  function renderLevels() {
    const choices = element('level-choices')
    choices.replaceChildren()
    for (const [index, entry] of campaign.entries()) {
      const unlocked = canPlayStage(index, progress.completed)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'level-choice'
      button.disabled = !unlocked
      button.setAttribute('aria-label', `第 ${index + 1} 关 ${entry.name}${unlocked ? '' : ' 尚未解锁'}`)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 48
      canvas.className = 'level-preview'
      canvas.setAttribute('aria-hidden', 'true')
      const ctx = canvas.getContext('2d')!
      const width = 48 / entry.level.pictureColumnsBottomToTop.length
      const height = 48 / Math.max(...entry.level.pictureColumnsBottomToTop.map(cells => cells.length))
      for (const [col, cells] of entry.level.pictureColumnsBottomToTop.entries()) {
        for (const [row, color] of cells.entries()) {
          ctx.fillStyle = entry.level.palette[color].hex
          ctx.fillRect(col * width, 48 - (row + 1) * height, width + .1, height + .1)
        }
      }
      const description = document.createElement('span')
      const detail = document.createElement('small')
      detail.textContent = `第 ${index + 1} 关 · ${entry.lesson}`
      const title = document.createElement('strong')
      title.textContent = entry.name
      description.append(detail, title)
      const state = document.createElement('span')
      state.className = 'play-icon'
      state.textContent = progress.completed.includes(entry.level.id) ? '✓' : unlocked ? '▶' : '锁'
      button.append(canvas, description, state)
      button.addEventListener('click', () => {
        levels.close()
        if (stageIndex !== index || runEnded) restart(index)
      })
      choices.append(button)
    }
  }

  function openPanel(panel: HTMLDialogElement) {
    accrue()
    panel.showModal()
    nextStep = null
  }
  for (const panel of [settings, levels]) panel.addEventListener('close', () => {
    clock = performance.now()
    nextStep = null
    schedule()
  })

  quality.addEventListener('click', () => {
    const low = quality.getAttribute('aria-pressed') !== 'true'
    quality.setAttribute('aria-pressed', String(low))
    field.setLowQuality(low)
    progress.lowPower = low
    save()
  })
  element('settings').addEventListener('click', () => openPanel(settings))
  element('levels').addEventListener('click', () => { renderLevels(); openPanel(levels) })
  element('restart').addEventListener('click', () => {
    settings.close()
    restart()
    queueViews[0].head.focus({ preventScroll: true })
  })
  again.addEventListener('click', () => {
    restart()
    queueViews[0].head.focus({ preventScroll: true })
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      const delta = Math.max(0, performance.now() - clock)
      if (!runEnded && !settings.open && !levels.open) { run.durationMs += delta; if (waiting) run.waitingMs += delta }
    }
    clock = performance.now()
    nextStep = null
    if (!document.hidden) schedule()
  })
  window.addEventListener('resize', schedule)

  Object.defineProperty(window, 'colorFlow', {
    value: Object.freeze({
      snapshot: () => game.snapshot(),
      moving: () => game.moving,
      solver: () => game.material && { backend: game.material.wasmBytes ? 'wasm' : 'js', wasmBytes: game.material.wasmBytes },
      replay: () => game.replay(),
      verifyReplay: (record = game.replay()) =>
        playReplay(record.levelId === legacyTutorial.id ? legacyTutorial
          : campaign.find(entry => entry.level.id === record.levelId)?.level ?? tutorial, record),
      stats: () => ({ current: { ...run }, history: structuredClone(progress.runs) }),
    }),
  })

  element('next').addEventListener('click', () => {
    if (stageIndex < campaign.length - 1) restart(stageIndex + 1)
    else { renderLevels(); openPanel(levels) }
  })
  let exportUrl: string | undefined
  element('export-stats').addEventListener('click', () => {
    const json = JSON.stringify({ version: 1, runs: progress.runs, current: runEnded ? null : run }, null, 2)
    element<HTMLTextAreaElement>('stats-data').value = json
    if (exportUrl) URL.revokeObjectURL(exportUrl)
    exportUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    element<HTMLAnchorElement>('stats-download').href = exportUrl
    element<HTMLDialogElement>('stats-panel').showModal()
  })
  window.addEventListener('pagehide', () => finishRun('left'))
  window.addEventListener('pageshow', event => { if (event.persisted) restart() })
  quality.setAttribute('aria-pressed', String(progress.lowPower))
  field.setLowQuality(progress.lowPower)
  beginRun()
  renderLevels()
  element('level-no').textContent = `融画 · 第 ${stageIndex + 1} 关`
  element('stage-title').textContent = stage.name
  document.title = `融画 · ${stage.name}`
  element('game-table').setAttribute('aria-label', `${stage.name}游戏区`)
  updateUI()
  schedule()
}
