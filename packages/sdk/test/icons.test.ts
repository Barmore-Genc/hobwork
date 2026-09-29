import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { defaultIcon, ICONS_DIR, iconSource, letterIconSvg, twemojiName } from '../src/icons/icon.ts'
import { IconError, renderIcons } from '../src/icons/render.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hobwork-icons-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function project(icon?: string) {
  writeFileSync(join(dir, 'hobwork.json'), JSON.stringify(icon === undefined ? {} : { icon }))
}

async function pixel(size: number, x: number, y: number) {
  const { data, info } = await sharp(join(dir, 'dist', ICONS_DIR, `icon-${size}.png`))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  expect([info.width, info.height]).toEqual([size, size])
  const at = (y * info.width + x) * 4
  return [...data.subarray(at, at + 4)]
}

test('names Twemoji files by code point', () => {
  expect(twemojiName('🧵')).toBe('1f9f5')
  expect(twemojiName('❤️')).toBe('2764')
  expect(twemojiName('❤️‍🔥')).toBe('2764-fe0f-200d-1f525')
  expect(twemojiName('👨‍👩‍👧')).toBe('1f468-200d-1f469-200d-1f467')
})

test('tells emoji, image paths and the default apart', () => {
  expect(iconSource('filament', '🧵')).toEqual({ emoji: '🧵' })
  expect(iconSource('filament', 'ui/icon.svg')).toEqual({ path: 'ui/icon.svg' })
  expect(iconSource('filament', 'ui/icon.jpeg')).toEqual({ path: 'ui/icon.jpeg' })
  expect(iconSource('filament', undefined)).toEqual(defaultIcon('filament'))
})

test('the default icon is the first letter on a color that stays the same', () => {
  expect(defaultIcon('filament')).toEqual(defaultIcon('filament'))
  expect(defaultIcon('filament').letter).toBe('F')
  expect(defaultIcon('3d-prints').letter).toBe('3')
  expect(letterIconSvg(defaultIcon('filament'))).toContain('>F</text>')
})

test('renders an emoji on a background, and without one for the favicon', async () => {
  project('🧵')
  await renderIcons({ dir, project: 'filament' })
  expect(readdirSync(join(dir, 'dist', ICONS_DIR)).sort()).toEqual([
    'icon-180.png',
    'icon-192.png',
    'icon-32.png',
    'icon-512.png',
  ])
  expect(await pixel(512, 0, 0)).toEqual([0xf5, 0xf7, 0xf2, 255])
  expect(await pixel(180, 179, 179)).toEqual([0xf5, 0xf7, 0xf2, 255])
  expect((await pixel(32, 0, 16))[3]).toBe(0)
  expect((await pixel(512, 256, 256))[3]).toBe(255)
})

test('renders a project image and replaces stale icons from the build', async () => {
  mkdirSync(join(dir, 'ui'))
  await sharp({ create: { width: 40, height: 20, channels: 4, background: '#ff0000' } }).png().toFile(join(dir, 'ui/icon.png'))
  mkdirSync(join(dir, 'dist', '_hobwork', 'old'), { recursive: true })
  project('ui/icon.png')
  await renderIcons({ dir, project: 'filament' })
  expect(readdirSync(join(dir, 'dist', '_hobwork'))).toEqual(['icons'])
  expect(await pixel(192, 96, 96)).toEqual([255, 0, 0, 255])
  // A wide image is fit into the square, with the background above and below.
  expect(await pixel(192, 96, 5)).toEqual([0xf5, 0xf7, 0xf2, 255])
})

test('renders an SVG sharp at every size', async () => {
  mkdirSync(join(dir, 'ui'))
  writeFileSync(join(dir, 'ui/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" width="4" height="4"><rect width="4" height="4" fill="#00f"/></svg>')
  project('ui/icon.svg')
  await renderIcons({ dir, project: 'filament' })
  expect(await pixel(512, 1, 1)).toEqual([0, 0, 255, 255])
})

test('renders the default icon without an icon in hobwork.json', async () => {
  project()
  await renderIcons({ dir, project: 'filament' })
  const { background } = defaultIcon('filament')
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16))
  expect(await pixel(512, 2, 2)).toEqual([r, g, b, 255])
  expect((await pixel(32, 0, 0))[3]).toBe(0)
})

test.each([
  ['nope', 'not a single emoji'],
  ['ui/missing.png', 'not a file in the hob'],
  ['../outside.png', 'must be a path inside the hob'],
  ['ui/broken.png', 'is not an SVG, PNG, JPEG or WebP image'],
])('refuses %s', async (icon, message) => {
  mkdirSync(join(dir, 'ui'))
  writeFileSync(join(dir, 'ui/broken.png'), 'not a png')
  project(icon)
  const rendering = renderIcons({ dir, project: 'filament' })
  await expect(rendering).rejects.toThrow(IconError)
  await expect(rendering).rejects.toThrow(message)
})
