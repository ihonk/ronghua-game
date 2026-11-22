import './style.css'
import { mountFluidLab } from './fluid-lab.ts'
import { mountGame } from './main.ts'
import { createWasmParticleFactory } from './particle-solver.ts'
import solverUrl from '../wasm/particle-solver.wasm?url&inline'

const params = new URLSearchParams(location.search)
const createSolver = params.get('solver') === 'js' ? undefined : createWasmParticleFactory(() =>
  Uint8Array.from(atob(solverUrl.slice(solverUrl.indexOf(',') + 1)), char => char.charCodeAt(0)))

if (params.get('lab') === 'fluid') {
  mountFluidLab(document.querySelector('main')!, createSolver)
} else {
  mountGame(createSolver)
}
