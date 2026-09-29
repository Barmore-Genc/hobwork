// Project icons. The host mounts this directory into pipeline VMs, where
// main.ts renders the icon after `pnpm run build`, and imports it to serve the
// icons and the default for builds without them.

// Favicon, apple-touch-icon, and the web manifest's icons. The project list
// uses 192 too.
export const ICON_SIZES = [32, 180, 192, 512] as const
export const FAVICON_SIZE = 32
export const LIST_ICON_SIZE = 192

// Relative to the build (dist/). Paths under /_hobwork/ on an app origin are
// the host's, so project files there were never reachable anyway.
export const ICONS_DIR = '_hobwork/icons'

export function iconFile(size: number): string {
  return `icon-${size}.png`
}

const IMAGE_PATH = /\.(svg|png|jpe?g|webp)$/

export type LetterIcon = { letter: string; background: string; color: string }
export type IconSource = { emoji: string } | { path: string } | LetterIcon

// Light theme colors (packages/theme/theme.css), with the text color that
// reads on each.
const LETTER_COLORS = [
  { background: '#c8952e', color: '#1e1a10' },
  { background: '#357350', color: '#ffffff' },
  { background: '#2f6fb0', color: '#ffffff' },
  { background: '#a63a2b', color: '#ffffff' },
  { background: '#9a5a00', color: '#ffffff' },
]

// Behind emoji and transparent images on every size but the favicon: iOS
// fills transparency on home screen icons with black.
export const ICON_BACKGROUND = '#f5f7f2'

export function defaultIcon(project: string): LetterIcon {
  let hash = 0
  for (const char of project) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const letter = (/[a-z0-9]/i.exec(project)?.[0] ?? '?').toUpperCase()
  return { letter, ...LETTER_COLORS[hash % LETTER_COLORS.length]! }
}

// `icon` from hobwork.json, which the schema checked.
export function iconSource(project: string, icon: unknown): IconSource {
  if (typeof icon !== 'string' || icon === '') return defaultIcon(project)
  return IMAGE_PATH.test(icon) ? { path: icon } : { emoji: icon }
}

// Twemoji names its files by code points, leaving out U+FE0F unless the
// sequence has a zero width joiner.
export function twemojiName(emoji: string): string {
  const points = [...emoji].map((char) => char.codePointAt(0)!)
  const kept = points.includes(0x200d) ? points : points.filter((point) => point !== 0xfe0f)
  return kept.map((point) => point.toString(16)).join('-')
}

// Only the favicon rounds its corners. The other sizes are home screen and
// manifest icons, which the OS masks itself.
export function letterIconSvg(icon: LetterIcon, favicon = false): string {
  const letter = icon.letter.replace(/[&<>]/g, (char) => `&#${char.charCodeAt(0)};`)
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    `<rect width="100" height="100"${favicon ? ' rx="18"' : ''} fill="${icon.background}"/>` +
    '<text x="50" y="50" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-weight="700" font-size="60" ' +
    `fill="${icon.color}" text-anchor="middle" dominant-baseline="central">${letter}</text></svg>`
  )
}
