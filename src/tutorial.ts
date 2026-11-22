import { parseLevel } from './level.ts'

// Wider artwork for the project's original R-G-B-B buffer example.
const blueHeights = [2, 3, 4, 5, 6, 7, 8, 8, 7, 6, 5, 4, 3, 2]
const blueTotal = blueHeights.reduce((sum, height) => sum + height, 0)
const firstBlue = Math.ceil(blueTotal / 2)
const bandCapacity = blueHeights.length * 3

export const legacyTutorial = parseLevel({
  id: 'tidal-bands',
  version: 1,
  slotCount: 5,
  palette: {
    R: { hex: '#ff865e', name: '珊瑚橙', mark: '◆' },
    G: { hex: '#a8edba', name: '薄荷绿', mark: '▲' },
    B: { hex: '#9d91fa', name: '暮紫', mark: '●' },
  },
  pictureColumnsBottomToTop: blueHeights.map(height =>
    [...Array<string>(3).fill('R'), ...Array<string>(3).fill('G'), ...Array<string>(height).fill('B')]),
  cupQueuesFrontToBack: [
    [{ id: 'a1', color: 'B', capacity: firstBlue }, { id: 'a2', color: 'R', capacity: bandCapacity }],
    [{ id: 'b1', color: 'G', capacity: bandCapacity }, { id: 'b2', color: 'B', capacity: blueTotal - firstBlue }],
  ],
})

const palette = {
  R: { hex: '#f18791', name: '珊瑚粉', mark: '◆' },
  G: { hex: '#5abdc4', name: '潮水青', mark: '▲' },
  B: { hex: '#f8ce8a', name: '贝壳金', mark: '●' },
}

const size = 24
const material = Array.from({ length: size }, (_, column) =>
  Array.from({ length: size }, (_, row) => {
    // Draw the scalloped outline into the actual material grid.
    const x = (column + .5) / size * 2 - 1
    const y = (row + .5) / size
    const dy = (y - .215) * 2
    const angle = Math.atan2(x, dy)
    const distance = Math.hypot(x, dy)
    const ribs = Math.cos(angle * 16.5)
    const rim = 1.13 + ribs * .047
    const shell = dy > 0 && Math.abs(angle) < 1.15 && distance < rim
    const hinge = Math.hypot(x / .21, (y - .232) / .061) < 1
    const sparkle = Math.abs(column - 4) + Math.abs(row - 17) <= 1
      || Math.abs(column - 20) + Math.abs(row - 15) <= 1
    if (shell || hinge || sparkle) return 'B'
    if (y < .155 + .030 * Math.sin(x * 3.8 + 1)
        || (y < .215 && Math.cos(x * 17) > .89)) {
      return 'R'
    }
    return 'G'
  }),
)

const cells = material.flat()
const count = (color: string) => cells.filter(cell => cell === color).length
const gold = count('B')
const firstGold = Math.ceil(gold * .52)

export const tutorial = parseLevel({
  id: 'shell-lagoon',
  version: 1,
  slotCount: 5,
  palette,
  pictureColumnsBottomToTop: material,
  cupQueuesFrontToBack: [
    [{ id: 'a1', color: 'B', capacity: firstGold }, { id: 'a2', color: 'R', capacity: count('R') }],
    [{ id: 'b1', color: 'G', capacity: count('G') }, { id: 'b2', color: 'B', capacity: gold - firstGold }],
  ],
})
