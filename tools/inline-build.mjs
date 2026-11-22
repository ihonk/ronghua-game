import { readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const root = resolve('dist')
const page = resolve(root, 'index.html')
const assets = []
let html = await readFile(page, 'utf8')

async function embed(pattern, wrap) {
  const tag = html.match(pattern)
  if (!tag) throw new Error('Expected a matching Vite asset')
  const asset = resolve(root, tag[1].replace(/^\//, ''))
  if (relative(root, asset).startsWith('..')) throw new Error('Vite asset is outside dist')
  const content = await readFile(asset, 'utf8')
  html = html.replace(tag[0], () => wrap(content))
  assets.push(asset)
}

await embed(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/, src =>
  `<script type="module">${src.replace(/<\/script/gi, '<\\/script')}</script>`)
await embed(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/, css =>
  `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)

const license = await readFile('node_modules/three/LICENSE', 'utf8')
html = html.replace('<head>', `<head>\n<!-- Three.js\n${license}--> `)
await writeFile(page, html)
for (const asset of assets) await unlink(asset)
console.log(`Standalone game: ${relative(process.cwd(), page)} (${Buffer.byteLength(html)} bytes)`)
