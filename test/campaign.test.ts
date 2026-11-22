import assert from 'node:assert/strict'
import { test } from 'node:test'
import { campaign, canPlayStage } from '../src/campaign.ts'
import { Game, playReplay } from '../src/game.ts'
import { readProgress, writeProgress } from '../src/progress.ts'

function play(game: Game, queue: number) {
  const events = game.step([{ queue, expectedCup: game.queues[queue][0].id }])
  let steps = 0
  while (game.moving && steps++ < 2000) events.push(...game.step())
  assert.ok(steps < 2000, '关卡应能稳定')
  return events
}

test('三关按提供顺序可通关并重放，等待与占槽压力逐步增加', () => {
  const peaks: number[] = []
  for (const stage of campaign.slice(0, 3)) {
    const game = new Game(stage.level)
    const events = []
    let peak = 0
    for (const queue of stage.solution) {
      const stepEvents = play(game, queue)
      // Track occupied slots from events, including cups that leave within a batch.
      let occupied = events.filter(event => event.type === 'put').length - events.filter(event => event.type === 'release').length
      for (const event of stepEvents) {
        if (event.type === 'put') occupied++
        if (event.type === 'release') occupied--
        peak = Math.max(peak, occupied)
      }
      events.push(...stepEvents)
    }
    assert.equal(game.outcome, 'won', stage.name)
    assert.deepEqual(playReplay(stage.level, game.replay()), { snapshot: game.snapshot(), events })
    peaks.push(peak)
  }
  assert.deepEqual(peaks, [2, 4, 5])
})

test('原创肖像体验关可直接进入，四种颜色与四列杯子能完整收集并回放', () => {
  const stage = campaign[3]
  assert.equal(canPlayStage(3, []), true)
  assert.equal(stage.level.cupQueuesFrontToBack.length, 4)
  assert.equal(Object.keys(stage.level.palette).length, 4)
  assert.equal(stage.level.pictureColumnsBottomToTop.flat().length, 4096)
  const game = new Game(stage.level, undefined, stage.rulesVersion)
  assert.equal(game.replay().rulesVersion, 7)
  const events = stage.solution.flatMap(queue => play(game, queue))
  assert.equal(game.outcome, 'won')
  assert.deepEqual(playReplay(stage.level, game.replay()), { snapshot: game.snapshot(), events })
  const saved = JSON.stringify({ version: 1, selected: 3, completed: [], attempts: {}, runs: [] })
  assert.equal(readProgress({ getItem: () => saved }, campaign).selected, 3)
})

test('灯塔关先送金杯会等待，水母关错误顺序会堵槽', () => {
  const waiting = new Game(campaign[1].level)
  play(waiting, 0)
  assert.equal(waiting.slots[0]?.filled, 0)
  assert.equal(waiting.slots[0]?.reserved, 0)
  const blocked = new Game(campaign[2].level)
  for (const queue of [0, 0, 1, 1, 1]) play(blocked, queue)
  assert.equal(blocked.outcome, 'stuck')
  assert.equal(blocked.slots.filter(Boolean).length, 5)
})

test('本地记录能恢复解锁进度，损坏数据及禁用存储有可用回退', () => {
  let raw = ''
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value } }
  const progress = readProgress(storage, campaign)
  progress.completed.push(campaign[0].level.id)
  progress.selected = 1
  progress.attempts[campaign[0].level.id] = 2
  assert.equal(writeProgress(storage, progress), true)
  assert.equal(readProgress(storage, campaign).selected, 1)
  progress.selected = 2
  writeProgress(storage, progress)
  assert.equal(readProgress(storage, campaign).selected, 0, '未解锁关不能从存储跳入')
  raw = 'broken json'
  assert.equal(readProgress(storage, campaign).selected, 0)
  assert.equal(writeProgress({ setItem: () => { throw new Error('unavailable') } }, progress), false)
})
