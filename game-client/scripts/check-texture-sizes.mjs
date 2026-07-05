/** One-off: verify PIXI texture frame sizes for character + gear (node lacks canvas — read spritesheet JSON only). */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'static/sprites/spritesheets/items/manifest.json'), 'utf8')
)
const rod = manifest.items.find((i) => i.id === 'fishing_rod')
console.log('rod left rect', rod?.faces?.left?.rect)
console.log('rod sprite crop', { x: rod?.sprite?.x, y: rod?.sprite?.y, w: rod?.sprite?.w, h: rod?.sprite?.h })
