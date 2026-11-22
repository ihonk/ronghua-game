import { parseLevel } from './level.ts'

const palette = {
  C: { hex: '#fff0d6', name: '奶油白', mark: '●' },
  T: { hex: '#67bdb6', name: '海松青', mark: '▲' },
  N: { hex: '#40476b', name: '靛蓝', mark: '■' },
  P: { hex: '#eba982', name: '杏桃', mark: '◆' },
}

const ellipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1

function portraitColor(x: number, y: number) {
  let color = 'C'
  // Sea and small wind marks behind an original beret-wearing painter.
  if (y < .30 + .035 * Math.sin(x * 14)) color = 'T'
  if (ellipse(x, y, .14, .77, .075, .035) || ellipse(x, y, .20, .79, .05, .025)) color = 'T'
  if (y > .39 && y < .41 && x > .80 && x < .96) color = 'T'
  if (ellipse(x, y, .53, -.12, .40, .48)) color = 'N'
  if (y < .27 && Math.abs(x - .53) < .12 + (.27 - y) * .30) color = 'T'
  if (y < .22 && y > .08 && Math.abs(x - .53) < .085 && Math.sin(y * 65) > .4) color = 'C'
  if (ellipse(x, y, .53, .32, .065, .105)) color = 'P'
  if (ellipse(x, y, .53, .315, .16, .052)) color = 'C'
  if (ellipse(x, y, .53, .54, .215, .245)) color = 'N'
  if (ellipse(x, y, .53, .515, .175, .205)) color = 'P'
  if (ellipse(x, y, .345, .50, .036, .056) || ellipse(x, y, .71, .50, .03, .05)) color = 'P'
  // Swept fringe and broad tilted beret, with a short stem.
  if (y > .64 && y < .76 && Math.abs(x - .52) < .19 && y > .66 + .24 * (x - .50)) color = 'N'
  if (ellipse(x, y + (x - .5) * .14, .50, .795, .28, .093)) color = 'N'
  if (ellipse(x, y, .47, .89, .022, .042)) color = 'N'
  for (const eye of [.455, .605]) {
    if (ellipse(x, y, eye, .535, .067, .057)) color = 'N'
    if (ellipse(x, y, eye, .535, .050, .040)) color = 'P'
    if (ellipse(x, y, eye + .009, .536, .013, .018)) color = 'N'
    if (ellipse(x, y, eye - .012, .551, .014, .008)) color = 'C'
  }
  if (y > .535 && y < .549 && x > .51 && x < .55) color = 'N'
  if (ellipse(x, y, .545, .478, .017, .013)) color = 'N'
  if (ellipse(x, y, .54, .422, .052, .018) && y < .422) color = 'N'
  // A brush on the apron provides a slender contrasting part to watch deform.
  if (y < .25 && y > .075 && x > .65 && x < .67) color = 'P'
  if (ellipse(x, y, .66, .266, .026, .038)) color = 'N'
  return color
}

const size = 64
const board = Array.from({ length: size }, (_, col) =>
  Array.from({ length: size }, (_, row) => portraitColor((col + .5) / size, (row + .5) / size)))
const orders = [['T', 'C', 'P'], ['C', 'N', 'T'], ['N', 'P', 'C'], ['T', 'N', 'C']]
const totals = new Map<string, number>()
const cupCounts = new Map<string, number>()
const allocated = new Map<string, number>()
for (const color of board.flat()) totals.set(color, (totals.get(color) ?? 0) + 1)
for (const color of orders.flat()) cupCounts.set(color, (cupCounts.get(color) ?? 0) + 1)

export const portrait = parseLevel({
  id: 'seaside-painter', version: 1, slotCount: 5, palette,
  pictureColumnsBottomToTop: board,
  cupQueuesFrontToBack: orders.map((queue, col) => queue.map((color, row) => {
    const total = totals.get(color)!
    const count = cupCounts.get(color)!
    const index = allocated.get(color) ?? 0
    allocated.set(color, index + 1)
    return { id: `painter-${col}-${row}`, color, capacity: Math.floor(total / count) + (index < total % count ? 1 : 0) }
  })),
})
