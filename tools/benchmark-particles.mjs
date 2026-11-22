import { readFileSync } from 'node:fs'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import assert from 'node:assert/strict'
import { campaign } from '../src/campaign.ts'
import { Game } from '../src/game.ts'
import { createWasmParticleFactory } from '../src/particle-solver.ts'

const bytes = readFileSync(new URL('../wasm/particle-solver.wasm', import.meta.url))
const createWasm = createWasmParticleFactory(() => bytes)
const { level, rulesVersion } = campaign[3]
const ticks = 60
const samples = 5
const command = { queue: 0, expectedCup: level.cupQueuesFrontToBack[0][0].id }

function run(factory) {
  const initStart = performance.now()
  const game = new Game(level, undefined, rulesVersion, factory)
  const initMs = performance.now() - initStart
  const start = process.cpuUsage()
  for (let tick = 0; tick < ticks; tick++) game.step(tick === 0 ? [command] : undefined)
  const { user, system } = process.cpuUsage(start)
  return { cpuMs: (user + system) / 1000, initMs, snapshot: game.snapshot(), wasmBytes: game.material.wasmBytes }
}

const coldWasm = run(createWasm)
const coldJs = run(undefined)
assert.ok(coldWasm.wasmBytes, 'WASM module did not initialize')
assert.deepEqual(coldWasm.snapshot, coldJs.snapshot)

// Both backends have run once. Alternate the order to limit warm-up bias.
const js = []
const wasm = []
for (let i = 0; i < samples; i++) {
  if (i % 2 === 0) {
    js.push(run(undefined))
    wasm.push(run(createWasm))
  } else {
    wasm.push(run(createWasm))
    js.push(run(undefined))
  }
  assert.deepEqual(wasm[i].snapshot, js[i].snapshot)
}

function median(runs, key) {
  return Number(runs.map(run => run[key]).sort((a, b) => a - b)[Math.floor(runs.length / 2)].toFixed(2))
}
console.log({
  ticks, samples, particles: level.pictureColumnsBottomToTop.flat().length,
  remaining: coldWasm.snapshot.particles.length,
  cpuMs: { js: median(js, 'cpuMs'), wasm: median(wasm, 'cpuMs') },
  coldGameInitMs: { js: +coldJs.initMs.toFixed(2), wasm: +coldWasm.initMs.toFixed(2) },
  warmGameInitMs: { js: median(js, 'initMs'), wasm: median(wasm, 'initMs') },
  moduleBytes: bytes.length,
  gzipModuleBytes: gzipSync(bytes).length,
  brotliModuleBytes: brotliCompressSync(bytes).length,
  wasmMemoryBytes: coldWasm.wasmBytes,
})
