import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Game, playReplay, RULES_VERSION, TIMING } from '../src/game.ts'
import { parseLevel } from '../src/level.ts'
import { tutorial } from '../src/tutorial.ts'
import type { Event } from '../src/game.ts'

const paletteFor = (colors: string[]) => Object.fromEntries(colors.map(color => [color, { hex: '#9988ff', name: color, mark: '●' }]))

function fixture(board: string[], queues: { color: string; capacity?: number }[][], slotCount = 5) {
  return parseLevel({
    id: 'fixture',
    version: 1,
    slotCount,
    palette: paletteFor(board),
    pictureColumnsBottomToTop: [board],
    cupQueuesFrontToBack: queues.map((queue, col) => queue.map((cup, row) => ({
      id: `${col}-${row}`,
      color: cup.color,
      capacity: cup.capacity ?? 1,
    }))),
  })
}

function play(game: Game, queue: number) {
  const head = game.queues[queue][0]!
  const events = game.step([{ queue, expectedCup: head.id }])
  while (game.moving) events.push(...game.step())
  return events
}

test('原创教学关从 0% 等待自动装填，同一份记录重现事件与结局', () => {
  const game = new Game(tutorial)
  const events = play(game, 0)
  assert.equal(game.slots[0]?.filled, 0)
  assert.equal(game.moving, false)
  for (const index of [0, 1, 1]) events.push(...play(game, index))
  assert.equal(game.outcome, 'won')
  assert.deepEqual(playReplay(tutorial, game.replay()), { snapshot: game.snapshot(), events })
})

test('教学关的匹配材料和杯内进度在多个规则步内逐次变化', () => {
  const game = new Game(tutorial)
  play(game, 0)
  const redCapacity = tutorial.cupQueuesFrontToBack[0][1].capacity
  const startRed = game.columns.flat().filter(cell => cell.color === 'R').length
  const opening = game.step([{ queue: 0, expectedCup: 'a2' }])
  const firstDrops = opening.filter(event => event.type === 'flow')
  assert.ok(firstDrops.length > 0 && firstDrops.length < redCapacity)
  assert.equal(game.columns.flat().filter(cell => cell.color === 'R').length, startRed - firstDrops.length)
  assert.equal(game.slots[1]?.filled, 0)

  const arrivals = new Set<number>()
  for (let step = 0; game.moving && step < 100; step++) {
    for (const event of game.step()) {
      if (event.type === 'fill' && event.id === 'a2' && event.filled < redCapacity) arrivals.add(game.tick)
    }
  }
  assert.ok(arrivals.size >= 15, '装填过程应在多个时间点产生真实进度')
  assert.equal(game.slots[1], null, '装满后离场')
  assert.equal(game.snapshot().exited.R, redCapacity)
})

test('规则 v1 的回放仍以旧的同一步出料方式重算', () => {
  const level = fixture(['B', 'B', 'B'], [[{ color: 'B', capacity: 3 }]])
  const replay = playReplay(level, {
    levelId: level.id,
    levelVersion: level.version,
    rulesVersion: 1,
    timing: { stepMs: 50, transferTicks: 9, exitTicks: 8 },
    endTick: 1,
    inputs: [{ tick: 1, order: 0, queue: 0, expectedCup: '0-0' }],
  })
  assert.deepEqual(replay.snapshot.columns, [[]])
  assert.deepEqual(replay.snapshot.transfers.map(transfer => transfer.due), [10, 10, 10])
  assert.equal(replay.events.filter(event => event.type === 'flow').length, 3)
})

test('v5就近收集回放保留，v4回放保留全宽轮转', () => {
  const level = parseLevel({
    id: 'local-flow', version: 1, slotCount: 5, palette: paletteFor(['T', 'C']),
    pictureColumnsBottomToTop: Array.from({ length: 20 }, () => ['T', 'T', 'C']),
    cupQueuesFrontToBack: [[{ id: 'left', color: 'T', capacity: 20 }, { id: 'rest', color: 'T', capacity: 20 },
      { id: 'cream', color: 'C', capacity: 20 }]],
  })
  const game = new Game(level, TIMING, 5)
  const events = play(game, 0)
  const columns = events.flatMap(e => e.type === 'flow' ? [e.transfer.column] : [])
  assert.ok(columns.every(col => col < 10), '左侧一杯的容量不应从右侧抽取')
  assert.deepEqual(game.columns.slice(12).map(c => c.slice(0, 2).map(v => v.color)),
    level.pictureColumnsBottomToTop.slice(12).map(c => c.slice(0, 2)), '远侧底部同色不被直接抽取，表面可参与补位')
  assert.deepEqual(playReplay(level, game.replay()), { snapshot: game.snapshot(), events })
  const legacy = playReplay(level, { ...game.replay(), rulesVersion: 4 })
  assert.ok(legacy.events.some(e => e.type === 'flow' && e.transfer.column >= 12))
  const twoCups = new Game(level)
  const concurrent = twoCups.step([{queue: 0, expectedCup: 'left'}, {queue: 0, expectedCup: 'rest'}])
  assert.deepEqual(concurrent.flatMap(e => e.type === 'flow' ? [[e.transfer.slot, e.transfer.column]] : []),
    [[0, 1], [1, 5]], '同色两杯各从自己槽位附近取料')
})

test('局部抽取时真实材料补满深沟，每步表面连续且颜色守恒，v5旧回放保留旧形变', () => {
  const level = parseLevel({
    id: 'fluid-surface', version: 1, slotCount: 5, palette: paletteFor(['T', 'C']),
    pictureColumnsBottomToTop: Array.from({length: 24}, () => [...Array<string>(8).fill('T'), ...Array<string>(16).fill('C')]),
    cupQueuesFrontToBack: [[{id:'teal',color:'T',capacity:64},{id:'teal-rest',color:'T',capacity:128},
      {id:'cream',color:'C',capacity:384}]],
  })
  const game = new Game(level)
  const events = game.step([{queue:0,expectedCup:'teal'}])
  let steps = 0
  while(game.moving && steps++ < 200) {
    const heights = game.columns.map(c => c.length)
    assert.ok(Math.max(...heights)-Math.min(...heights)<=1, '消耗只能降低整体液面，不留下深沟')
    events.push(...game.step())
  }
  assert.ok(steps < 200)
  assert.ok(events.some(e=>e.type==='slide' && e.slide.from!==e.slide.to))
  assert.equal(game.snapshot().exited.T,64)
  assert.deepEqual(playReplay(level,game.replay()),{snapshot:game.snapshot(),events})
  const legacy=playReplay(level,{...game.replay(),rulesVersion:5})
  assert.ok(Math.max(...legacy.snapshot.columns.map(c=>c.length))-Math.min(...legacy.snapshot.columns.map(c=>c.length))>1)
})

test('半速使每批出料和到杯的时间加倍，规则 v2 的回放保留原节拍', () => {
  const level = fixture(Array<string>(87).fill('R'), [[{ color: 'R', capacity: 87 }]])
  const arrivalTicks = (rulesVersion: number, timing: typeof TIMING) => {
    const replay = playReplay(level, {
      levelId: level.id,
      levelVersion: level.version,
      rulesVersion,
      timing,
      endTick: 100,
      inputs: [{ tick: 1, order: 0, queue: 0, expectedCup: '0-0' }],
    })
    assert.equal(replay.snapshot.outcome, 'won')
    return replay.events.flatMap(event => event.type === 'flow' ? [event.transfer.due - 1] : [])
  }
  const original = arrivalTicks(2, { ...TIMING, transferTicks: 6 })
  assert.equal(original.at(-1), 34)
  assert.deepEqual(arrivalTicks(RULES_VERSION, TIMING), original.map(tick => tick * 2))
})

test('v4两侧材料滑入中间缺口并按原色入杯，旧回放可以重复侧滑', () => {
  const level = parseLevel({
    id: 'slump-gap',
    version: 1,
    slotCount: 5,
    palette: paletteFor(['G', 'R', 'B']),
    pictureColumnsBottomToTop: ['G', 'R', 'B'].map(color => Array<string>(6).fill(color)),
    cupQueuesFrontToBack: ['R', 'G', 'B'].map(color => [{ id: color, color, capacity: 6 }]),
  })
  const game = new Game(level, TIMING, 4)
  const events = play(game, 0)
  for (const from of [0, 2]) {
    assert.ok(events.some(event => event.type === 'slide' && event.slide.from === from && event.slide.to === 1))
  }
  const settled = game.snapshot()
  assert.ok(settled.columns[1].length > 0, '中间缺口应接收两侧材料')
  assert.deepEqual(settled.exited, { R: 6 })
  const legacy = playReplay(level, { ...game.replay(), rulesVersion: 3 })
  assert.deepEqual(legacy.snapshot.columns[1], [])
  assert.ok(legacy.events.every(event => event.type !== 'slide'))
  events.push(...play(game, 1), ...play(game, 2))
  assert.deepEqual(game.snapshot().exited, { R: 6, G: 6, B: 6 })
  assert.equal(game.outcome, 'won')
  assert.deepEqual(playReplay(level, game.replay()), { snapshot: game.snapshot(), events })
})

test('研究关的奶白杯只在同色材料露出后开始接料', () => {
  const board = ['rose', 'purple', 'orange', 'blue', 'cream', 'green']
  const queues = [['rose', 'cream', 'orange'], ['purple', 'blue', 'green']]
  const solution = [0, 1, 0, 0, 1, 1]
  const level = fixture(board, queues.map(queue => queue.map(color => ({ color }))))
  const game = new Game(level)
  solution.slice(0, 3).forEach(index => play(game, index))
  assert.equal(game.slots.find(cup => cup?.color === 'cream')?.filled, 0)
  solution.slice(3).forEach(index => play(game, index))
  assert.equal(game.outcome, 'won')
})

test('二槽原创示例能验证死局并能在新局走通', () => {
  const level = fixture(['R', 'G', 'B', 'B'], [
    [{ color: 'B' }, { color: 'R' }],
    [{ color: 'G' }, { color: 'B' }],
  ], 2)
  const blocked = new Game(level)
  for (const index of [1, 0]) play(blocked, index)
  assert.equal(blocked.outcome, 'stuck')
  const fresh = new Game(level)
  for (const index of [0, 0, 1, 1]) play(fresh, index)
  assert.equal(fresh.outcome, 'won')
})

test('蓝杯停在 50%，隔色清除后完成', () => {
  const game = new Game(fixture(['B', 'R', 'B'], [[{ color: 'B', capacity: 2 }], [{ color: 'R' }]]))
  play(game, 0)
  assert.equal(game.slots[0]?.filled, 1)
  assert.equal(game.slots[0]?.reserved, 0)
  play(game, 1)
  assert.equal(game.outcome, 'won')
})

const slotFixture = () => fixture([...('RBBGGG')], ['BB', 'GGG', 'R'].map(q => [...q].map(color => ({ color }))))

function batch(game: Game, queueIndices: number[]): Event[] {
  const depth = Array<number>(game.queues.length).fill(0)
  return game.step(queueIndices.map(queue => ({ queue, expectedCup: game.queues[queue][depth[queue]++].id })))
}

test('五槽满而仍有在途材料，第六次投杯被拒后可以重试', () => {
  const game = new Game(slotFixture())
  const events = batch(game, [2, 0, 0, 1, 1, 1])
  assert.equal(game.slots.filter(Boolean).length, 5)
  assert.equal(game.outcome, 'playing')
  assert.equal(game.moving, true)
  assert.equal(events.find(event => event.type === 'reject')?.reason, 'full')
  assert.equal(game.queues[1][0].id, '1-2')
  while (game.moving) game.step()
  play(game, 1)
  assert.equal(game.outcome, 'won')
})

test('五槽满且局面无法自动推进时判死局', () => {
  const game = new Game(slotFixture())
  batch(game, [0, 0, 1, 1, 1])
  assert.equal(game.outcome, 'stuck')
  assert.equal(game.queues[2][0].color, 'R')
})

test('按同一杯 ID 连点只入槽一次', () => {
  const game = new Game(tutorial)
  const same = { queue: 0, expectedCup: 'a1' }
  const events = game.step([same, same])
  assert.equal(events[0].type, 'put')
  assert.equal(events[1].type, 'reject')
  assert.equal(game.queues[0][0].id, 'a2')
})

test('颜色引用、ID、容量校验能报告字段', () => {
  const malformed = structuredClone(tutorial)
  malformed.cupQueuesFrontToBack[0][0].color = 'unknown'
  assert.throws(() => parseLevel(malformed), /cupQueuesFrontToBack\[0\]\[0\].color/)
  malformed.cupQueuesFrontToBack[0][0].color = 'B'
  malformed.cupQueuesFrontToBack[0][0].capacity++
  assert.throws(() => parseLevel(malformed), /palette.B/)
  malformed.cupQueuesFrontToBack[0][1].id = malformed.cupQueuesFrontToBack[0][0].id
  assert.throws(() => parseLevel(malformed), /cupQueuesFrontToBack\[0\]\[1\].id/)
})
