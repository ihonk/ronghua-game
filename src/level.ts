export interface Cup {
  id: string
  color: string
  capacity: number
}

export interface PaletteColor {
  hex: string
  name: string
  mark: string
}

export interface Level {
  id: string
  version: number
  palette: Record<string, PaletteColor>
  slotCount: number
  pictureColumnsBottomToTop: string[][]
  cupQueuesFrontToBack: Cup[][]
}

function invalid(field: string, message: string): never {
  throw new Error(`${field}：${message}`)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, '应为对象')
  return value as Record<string, unknown>
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || !value.length) invalid(path, '应为非空数组')
  return value
}

function label(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(path, '应为非空字符串')
  return value
}

function quantity(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(path, '应为正整数')
  return value
}

export function parseLevel(input: unknown): Level {
  const data = record(input, 'level')
  const id = label(data.id, 'id')
  const version = quantity(data.version, 'version')
  const slotCount = quantity(data.slotCount, 'slotCount')
  const palette = Object.fromEntries(Object.entries(record(data.palette, 'palette')).map(([color, value]) => {
    const path = `palette.${color}`
    const entry = record(value, path)
    const hex = label(entry.hex, `${path}.hex`)
    if (!/^#[\da-f]{6}$/i.test(hex)) invalid(`${path}.hex`, '应为六位十六进制颜色')
    return [color, { hex, name: label(entry.name, `${path}.name`), mark: label(entry.mark, `${path}.mark`) }]
  }))
  const material = new Map<string, number>()
  const demand = new Map<string, number>()
  const cupIds = new Set<string>()
  function readColor(value: unknown, path: string) {
    const color = label(value, path)
    if (!Object.hasOwn(palette, color)) invalid(path, '颜色未在调色板中定义')
    return color
  }
  const pictureColumnsBottomToTop = list(data.pictureColumnsBottomToTop, 'pictureColumnsBottomToTop').map((column, col) => {
    const path = `pictureColumnsBottomToTop[${col}]`
    if (!Array.isArray(column)) invalid(path, '应为数组')
    return column.map((value, row) => {
      const color = readColor(value, `${path}[${row}]`)
      material.set(color, (material.get(color) ?? 0) + 1)
      return color
    })
  })
  if (!material.size) invalid('pictureColumnsBottomToTop', '至少要有一单位材料')
  const cupQueuesFrontToBack = list(data.cupQueuesFrontToBack, 'cupQueuesFrontToBack').map((queue, index) => {
    const path = `cupQueuesFrontToBack[${index}]`
    return list(queue, path).map((value, depth) => {
      const cupPath = `${path}[${depth}]`
      const cup = record(value, cupPath)
      const id = label(cup.id, `${cupPath}.id`)
      if (cupIds.has(id)) invalid(`${cupPath}.id`, '杯 ID 重复')
      cupIds.add(id)
      const color = readColor(cup.color, `${cupPath}.color`)
      const capacity = quantity(cup.capacity, `${cupPath}.capacity`)
      demand.set(color, (demand.get(color) ?? 0) + capacity)
      return { id, color, capacity }
    })
  })
  for (const color of Object.keys(palette)) {
    if ((material.get(color) ?? 0) !== (demand.get(color) ?? 0)) {
      invalid(`palette.${color}`, `画板有 ${material.get(color) ?? 0} 单位，杯容量为 ${demand.get(color) ?? 0} 单位`)
    }
  }
  return { id, version, slotCount, palette, pictureColumnsBottomToTop, cupQueuesFrontToBack }
}
