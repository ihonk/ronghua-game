import type { Stage } from './campaign.ts'

export interface Run {
  levelId: string
  attempt: number
  result: 'won' | 'stuck' | 'restart' | 'left'
  durationMs: number
  peakSlots: number
  firstFullMs: number | null
  waitingMs: number
}

export interface Progress {
  version: 1
  selected: number
  completed: string[]
  attempts: Record<string, number>
  runs: Run[]
  lowPower: boolean
}

const KEY = 'ronghua-progress-v1'

export function readProgress(storage: Pick<Storage, 'getItem'>, stages: Stage[]): Progress {
  const fresh: Progress = { version: 1, selected: 0, completed: [], attempts: {}, runs: [], lowPower: false }
  try {
    const saved = JSON.parse(storage.getItem(KEY) ?? 'null')
    if (!saved || saved.version !== 1) return fresh
    const ids = new Set(stages.map(stage => stage.level.id))
    const completed = Array.isArray(saved.completed) ? saved.completed.filter((id: unknown) => typeof id === 'string' && ids.has(id)) : []
    const unlocked = Math.min(stages.length - 1, stages.findIndex(stage => !completed.includes(stage.level.id)))
    const selected = Number.isInteger(saved.selected) && saved.selected >= 0 && saved.selected < stages.length
      && (stages[saved.selected].open || unlocked === -1 || saved.selected <= unlocked) ? saved.selected : 0
    const attempts = Object.fromEntries(stages.map(stage => {
      const n = saved.attempts?.[stage.level.id]
      return [stage.level.id, Number.isSafeInteger(n) && n >= 0 ? n : 0]
    }))
    const runs = Array.isArray(saved.runs) ? saved.runs.filter((run: Run) => run && ids.has(run.levelId)
      && ['won', 'stuck', 'restart', 'left'].includes(run.result)
      && [run.durationMs, run.waitingMs, run.peakSlots, run.attempt].every(n => Number.isFinite(n) && n >= 0)
      && (run.firstFullMs === null || Number.isFinite(run.firstFullMs) && run.firstFullMs >= 0)).slice(-100) : []
    return { version: 1, selected, completed, attempts, runs, lowPower: saved.lowPower === true }
  } catch {
    return fresh
  }
}

export function writeProgress(storage: Pick<Storage, 'setItem'>, progress: Progress): boolean {
  try {
    storage.setItem(KEY, JSON.stringify(progress))
    return true
  } catch {
    return false
  }
}
