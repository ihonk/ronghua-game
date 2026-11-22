import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { campaign } from '../src/campaign.ts'
import { Game, playReplay } from '../src/game.ts'
import { ParticleMaterial } from '../src/particle-material.ts'
import { createWasmParticleFactory } from '../src/particle-solver.ts'

const bytes = readFileSync(new URL('../wasm/particle-solver.wasm', import.meta.url))
const createWasm = createWasmParticleFactory(() => bytes)
const portrait = campaign[3]

test('WASM 与 JS 的 v7 肖像逐步状态、出料和完整回放一致', () => {
  const js = new Game(portrait.level, undefined, portrait.rulesVersion)
  const wasm = new Game(portrait.level, undefined, portrait.rulesVersion, createWasm)
  assert.ok(wasm.material!.wasmBytes > 0)

  const events = []
  let nextCup = 0
  for (let i = 0; i < 400 && js.outcome === 'playing'; i++) {
    const queue = portrait.solution[nextCup]
    const commands = []
    if (queue !== undefined && js.slots.includes(null)) {
      commands.push({ queue, expectedCup: js.queues[queue][0].id })
      nextCup++
    }
    const expected = js.step(commands)
    const actual = wasm.step(commands)
    assert.deepEqual(actual, expected, `events at tick ${js.tick}`)
    assert.deepEqual(wasm.snapshot(), js.snapshot(), `snapshot at tick ${js.tick}`)
    events.push(...actual)
  }

  assert.equal(wasm.tick, 323)
  assert.equal(wasm.outcome, 'won')
  assert.equal(events.filter(event => event.type === 'flow').length, 4096)
  assert.equal(wasm.replay().rulesVersion, 7)
  assert.deepEqual(playReplay(portrait.level, wasm.replay()), { snapshot: wasm.snapshot(), events })
})

test('WASM 支持不规则画板、单行和单列，局间内存独立', () => {
  for (const heights of [[0, 1, 0], [1, 1, 0, 1], [7], [43, 2, 0, 6, 9, 8]]) {
    let id = 0
    const columns = heights.map(height => Array.from({ length: height }, () => ({ id: id++, color: '青' })))
    const js = new ParticleMaterial(columns)
    const wasm = new ParticleMaterial(columns, createWasm)
    const restarted = new ParticleMaterial(columns, createWasm)
    assert.ok(wasm.wasmBytes > 0)
    assert.notEqual(wasm.x.buffer, restarted.x.buffer)
    for (let i = 0; i < 72; i++) {
      if (i % 8 === 0) {
        const outlets = [{ slot: 0, x: (i / 72) * heights.length, color: '青', amount: 2 }]
        assert.deepEqual(wasm.take(outlets), js.take(outlets))
      }
      wasm.advance()
      js.advance()
      for (const field of ['x', 'y', 'previousX', 'previousY', 'alive'] as const) {
        assert.deepEqual(wasm[field], js[field])
      }
    }
    assert.equal(restarted.remaining, columns.flat().length)
    assert.equal(restarted.revision, 0)
  }
})

test('模块编译失败回退到 JS，教程关不会申请 WASM 实例', () => {
  let requests = 0
  const broken = createWasmParticleFactory(() => {
    requests++
    return new Uint8Array()
  })
  assert.equal(new Game(campaign[0].level, undefined, undefined, broken).material, undefined)
  assert.equal(requests, 0)
  const wasmUnavailable = new Game(portrait.level, undefined, portrait.rulesVersion, broken)
  const js = new Game(portrait.level, undefined, portrait.rulesVersion)
  assert.equal(wasmUnavailable.material!.wasmBytes, 0)
  assert.deepEqual(wasmUnavailable.snapshot(), js.snapshot())
  const reset = new Game(portrait.level, undefined, portrait.rulesVersion, broken)
  assert.equal(reset.material!.wasmBytes, 0)
  assert.equal(requests, 1)
})
