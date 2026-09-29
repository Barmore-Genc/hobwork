import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, normalize } from 'node:path'
// Not ../hobwork-json.js: only this directory is mounted into the pipeline VM.
import { parseHobworkJson } from '@hobwork/sdk/hobwork-json'
import sharp from 'sharp'
import {
  FAVICON_SIZE,
  ICON_BACKGROUND,
  ICON_SIZES,
  ICONS_DIR,
  iconFile,
  iconSource,
  letterIconSvg,
  twemojiName,
  type LetterIcon,
} from './icon.ts'

// A wrong icon in hobwork.json. The pipeline shows the message to the agent.
export class IconError extends Error {}

const require = createRequire(import.meta.url)
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }
// Emoji leave a margin on the opaque icons, like app icons on a home screen.
const EMOJI_INSET = 0.16

// Emoji are drawn from Twemoji rather than a font, so an icon looks the same
// everywhere and stays sharp at 512px.
function twemoji(emoji: string): Buffer {
  const dir = dirname(require.resolve('@twemoji/svg/package.json'))
  const name = twemojiName(emoji)
  for (const file of new Set([name, name.replace(/-fe0f/g, '')])) {
    const path = join(dir, `${file}.svg`)
    if (existsSync(path)) return readFileSync(path)
  }
  throw new IconError(`hobwork.json: "icon" is "${emoji}", which is not a single emoji. Use one emoji or the path of an image.`)
}

function projectImage(dir: string, path: string): Buffer {
  const full = join(dir, normalize(path))
  if (!full.startsWith(join(dir, '/'))) {
    throw new IconError(`hobwork.json: "icon" must be a path inside the project, got "${path}"`)
  }
  if (!existsSync(full) || !lstatSync(full).isFile()) {
    throw new IconError(`hobwork.json: "icon" is "${path}", which is not a file in the project`)
  }
  return readFileSync(full)
}

// Fits the image into a square of `size`, leaving `inset` of it empty on each side.
async function renderImage(data: Buffer, size: number, options: { inset: number; opaque: boolean }): Promise<Buffer> {
  const meta = await sharp(data)
    .metadata()
    .catch(() => {
      throw new IconError('hobwork.json: "icon" is not an SVG, PNG, JPEG or WebP image')
    })
  const inner = Math.round(size * (1 - 2 * options.inset))
  const margin = Math.floor((size - inner) / 2)
  // An SVG is rasterized at its own size unless told otherwise, which would
  // blur a small SVG scaled up to 512px.
  const density =
    meta.format === 'svg' && meta.width && meta.height
      ? Math.min((72 * inner) / Math.max(meta.width, meta.height), 100_000)
      : undefined
  // sharp flattens before it resizes and extends, so the padding those add
  // needs the background color too.
  const background = options.opaque ? ICON_BACKGROUND : TRANSPARENT
  const image = sharp(data, density ? { density } : {})
    .resize(inner, inner, { fit: 'contain', background })
    .extend({ top: margin, left: margin, bottom: size - inner - margin, right: size - inner - margin, background })
  return (options.opaque ? image.flatten({ background }) : image).png().toBuffer()
}

function renderLetter(icon: LetterIcon, size: number): Promise<Buffer> {
  return sharp(Buffer.from(letterIconSvg(icon, size === FAVICON_SIZE)), { density: (72 * size) / 100 })
    .png()
    .toBuffer()
}

// Renders the icon from `dir`/hobwork.json into `dir`/dist/_hobwork/icons.
// The default icon's letter needs a font that fontconfig finds.
export async function renderIcons(options: { dir: string; project: string }): Promise<void> {
  const config = parseHobworkJson(readFileSync(join(options.dir, 'hobwork.json'), 'utf8')) as { icon?: unknown }
  const source = iconSource(options.project, config.icon)
  let render: (size: number) => Promise<Buffer>
  if ('letter' in source) render = (size) => renderLetter(source, size)
  else {
    const data = 'emoji' in source ? twemoji(source.emoji) : projectImage(options.dir, source.path)
    const inset = 'emoji' in source ? EMOJI_INSET : 0
    render = (size) =>
      size === FAVICON_SIZE ? renderImage(data, size, { inset: 0, opaque: false }) : renderImage(data, size, { inset, opaque: true })
  }
  const pngs = await Promise.all(ICON_SIZES.map(render))

  rmSync(join(options.dir, 'dist', '_hobwork'), { recursive: true, force: true })
  const out = join(options.dir, 'dist', ICONS_DIR)
  mkdirSync(out, { recursive: true })
  ICON_SIZES.forEach((size, i) => writeFileSync(join(out, iconFile(size)), pngs[i]!))
}
