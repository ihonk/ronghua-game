import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Game, playReplay } from '../src/game.ts'
import { campaign } from '../src/campaign.ts'

const stage = campaign[3]

test('肖像粒子从杯侧优先取料，邻侧横移补位，脸部连贯下沉', () => {
  for (const queue of [0, 3]) {
    const game = new Game(stage.level, undefined, stage.rulesVersion)
    const material = game.material!
    // Put a waiting cup in front of the right-side outlet so the second run has
    // a genuinely different receiving x, using the same teal source artwork.
    if (queue === 3) {
      game.step([1, 1, 2, 0].map((lane, index) => ({
        queue: lane, expectedCup: stage.level.cupQueuesFrontToBack[lane][index === 1 ? 1 : 0].id,
      })))
    }
    const colorCup = game.queues[queue][0]
    const events = game.step([{ queue, expectedCup: colorCup.id }])
    const slot = queue === 0 ? 0 : 4
    const flows = events.flatMap(event => event.type === 'flow' && event.transfer.slot === slot ? [event.transfer] : [])
    assert.ok(flows.length > 0)
    assert.ok(flows.every(flow => flow.cell.color === 'T' && (queue === 0 ? flow.source!.x < 16 : flow.source!.x > 40)))
    if (queue === 3) assert.ok(flows.slice(0, 4).every(flow => flow.source!.x > 55))

    const departing = new Set(flows.map(flow => flow.cell.id))
    assert.equal(game.slots[slot]!.reserved, flows.length)
    assert.equal(game.slots[slot]!.filled, 0)
    if (queue === 3) {
      assert.equal(game.slots.filter(Boolean).length, 5)
      assert.equal(game.outcome, 'playing')
      continue
    }
    for (let tick = 0; tick < 23; tick++) {
      for (const event of game.step()) {
        if (event.type !== 'flow') continue
        assert.ok(!departing.has(event.transfer.cell.id))
        departing.add(event.transfer.cell.id)
      }
    }
    assert.equal(game.remaining + departing.size, material.cells.length)
    const cup = game.slots[slot]!
    assert.equal(cup.filled + cup.reserved, departing.size)
    assert.ok(cup.filled + cup.reserved <= cup.capacity)
    const flowingFromSide = material.cells.filter(({ id }) =>
      material.alive[id] && Math.floor(id / 64) >= 14 && Math.floor(id / 64) <= 27 &&
      id % 64 < 13 && material.x[id] < Math.floor(id / 64) + .05)
    assert.ok(flowingFromSide.length > 30, '抽口旁的低层材料应横向流入')
    const face = material.cells.filter(({ id, color }) =>
      color === 'P' && id % 64 > 28 && id % 64 < 39 && Math.floor(id / 64) >= 22 && Math.floor(id / 64) < 45)
    const descent = face.reduce((sum, { id }) => sum + id % 64 + .5 - material.y[id], 0) / face.length
    assert.ok(descent > 1 && descent < 7, '脸部应随抽取逐步下沉')
    const intact = face.filter(({ id }) => {
      const distance = Math.hypot(material.x[id] - material.x[id - 1], material.y[id] - material.y[id - 1])
      return distance > .65 && distance < 1.4
    })
    assert.ok(intact.length > face.length * .95, '脸部相邻采样仍应连贯')
    assert.deepEqual(playReplay(stage.level, game.replay()).snapshot, game.snapshot())
  }
})

test('同一肖像的 v6 回放仍使用历史列模型', () => {
  const game = new Game(stage.level)
  const events = game.step([{ queue: 0, expectedCup: game.queues[0][0].id }])
  assert.equal(game.replay().rulesVersion, 6)
  assert.equal(game.material, undefined)
  assert.ok(events.some(event => event.type === 'slide'))
  assert.deepEqual(playReplay(stage.level, game.replay()), { snapshot: game.snapshot(), events })
})
