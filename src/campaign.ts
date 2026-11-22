import { parseLevel } from './level.ts'
import type { Level } from './level.ts'
import { tutorial } from './tutorial.ts'
import { portrait } from './portrait.ts'
import { PARTICLE_RULES_VERSION } from './game.ts'

export interface Stage {
  level: Level
  name: string
  lesson: string
  coach: string
  coachQueue: number
  solution: number[]
  open?: boolean
  rulesVersion?: number
}

const palette = {
  ...tutorial.palette,
  V: { hex: '#afa0ee', name: '暮紫', mark: '■' },
}

function artwork(id: string, draw: (x: number, y: number) => string, orders: string[][]): Level {
  const board = Array.from({ length: 24 }, (_, col) =>
    Array.from({ length: 24 }, (_, row) => draw((col + .5) / 24, (row + .5) / 24)))
  const count = (color: string) => board.flat().filter(value => value === color).length
  const cupsPerColor = new Map<string, number>()
  for (const color of orders.flat()) cupsPerColor.set(color, (cupsPerColor.get(color) ?? 0) + 1)
  const allocated = new Map<string, number>()
  const queues = orders.map((queue, col) => queue.map((color, row) => {
    const total = count(color)
    const pieces = cupsPerColor.get(color)!
    const index = allocated.get(color) ?? 0
    allocated.set(color, index + 1)
    return {
      id: `${id}-${col}-${row}`, color,
      capacity: Math.floor(total / pieces) + (index < total % pieces ? 1 : 0),
    }
  }))
  return parseLevel({ id, version: 1, palette, slotCount: 5,
    pictureColumnsBottomToTop: board, cupQueuesFrontToBack: queues })
}

const shell = parseLevel({ ...tutorial, id: 'shell-intro', palette,
  cupQueuesFrontToBack: [
    [tutorial.cupQueuesFrontToBack[0][1], tutorial.cupQueuesFrontToBack[0][0]],
    tutorial.cupQueuesFrontToBack[1],
  ],
})

const lighthouse = artwork('moon-lighthouse', (x, y) => {
  const wave = .19 + .018 * Math.sin(x * 15)
  if (y < wave) return 'G'
  const towerWidth = .065 + (.74 - y) * .065
  if (y < .74 && Math.abs(x - .51) < towerWidth) return y > .60 ? 'B' : 'R'
  if (y > .74 && y < .82 && Math.abs(x - .51) < (.82 - y) * 1.5) return 'R'
  if (Math.hypot(x - .24, y - .78) < .095) return 'B'
  if (y < .29 && Math.abs(x - .51) < .21) return 'R'
  return 'V'
}, [['B', 'G', 'R'], ['V', 'G', 'B']])

// A clear layered lower half makes the blocked-first sequence teach slot planning.
const jellyfish = artwork('jellyfish-current', (x, y) => {
  if (y < .125) return 'R'
  if (y < .255) return 'G'
  const bell = ((x - .5) / .32) ** 2 + ((y - .59) / .24) ** 2 < 1 && y > .50
  if (bell) return 'B'
  const tentacle = y > .29 && y < .51 && [0, 1, 2, 3].some(i =>
    Math.abs(x - (.32 + i * .12 + .025 * Math.sin(y * 38 + i))) < .022)
  if (tentacle) return 'B'
  if (Math.hypot(x - .19, y - .80) < .035 || Math.hypot(x - .84, y - .66) < .028) return 'G'
  return 'V'
}, [['B', 'V', 'R'], ['G', 'V', 'B'], ['V', 'G', 'R']])

export const campaign: Stage[] = [
  { level: shell, name: '贝壳浅滩', lesson: '同色收集', coach: '先接住底部的珊瑚粉', coachQueue: 0, solution: [0, 1, 0, 1] },
  { level: lighthouse, name: '月湾灯塔', lesson: '留杯等待', coach: '先送金杯，再取后面的青杯', coachQueue: 0, solution: [0, 0, 1, 0, 1, 1] },
  { level: jellyfish, name: '水母回游', lesson: '规划五个槽位', coach: '先找到通向珊瑚粉的队列', coachQueue: 0, solution: [0, 0, 0, 2, 2, 2, 1, 1, 1] },
  { level: portrait, name: '海风画师', lesson: '肖像体验关', coach: '先收集底部的海松青', coachQueue: 0,
    open: true, rulesVersion: PARTICLE_RULES_VERSION, solution: [0, 0, 0, 2, 3, 1, 1, 1, 2, 2, 3, 3] },
]

export function canPlayStage(index: number, completed: string[]) {
  return index === 0 || campaign[index]?.open === true || completed.includes(campaign[index - 1]?.level.id)
}
