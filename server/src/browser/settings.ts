// Where the browser is installed and how it runs. Everything is optional: a
// host that never installed a browser answers hobs with not_configured.

export type BrowserSettings = {
  // The host's own settings, from HOBWORK_BROWSER_*.
  dataDir: string
  // HOBWORK_BROWSER=off turns the browser off without uninstalling it.
  enabled: boolean
  // No command for this long closes the browser. The profile stays on disk.
  idleTimeoutMs: number
  // Tabs one hob may have open, and tabs in all.
  maxTabsPerHob: number
  maxTabs: number
  // HOBWORK_BROWSER_HEADLESS=1 runs without a display, which leaks the
  // HeadlessChrome user agent. Without it, Linux runs the browser under Xvfb.
  headless: boolean
  locale: string
  // Default: the host's time zone.
  timezoneId?: string
  window: { width: number; height: number }
  // A Chrome channel (chrome, msedge, chromium), for a host that wants the
  // installed browser rather than the one patchright downloaded. Extensions
  // cannot be side-loaded into Google Chrome or Edge.
  channel?: string
  // HOBWORK_BROWSER_EXECUTABLE: an exact binary, e.g. a distro's chromium.
  executablePath?: string
  // Where patchright's browsers and uBlock Origin Lite live, under dataDir.
  browsersPath: string
  profileDir: string
  extensionsDir: string
}

export const DEFAULT_BROWSER_IDLE_MS = 10 * 60 * 1000
export const DEFAULT_BROWSER_MAX_TABS = 8
export const DEFAULT_BROWSER_MAX_TABS_TOTAL = 32

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

function duration(name: string, text: string | undefined, fallback: number): number {
  if (text === undefined || text.trim() === '') return fallback
  const match = /^(\d+)(ms|s|m|h)$/.exec(text.trim())
  if (!match) throw new Error(`${name} must be a duration like 30s, 10m or 1h, got ${JSON.stringify(text)}`)
  return Math.max(1000, Number(match[1]) * UNITS[match[2]!]!)
}

function count(name: string, text: string | undefined, fallback: number): number {
  if (text === undefined || text.trim() === '') return fallback
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1 || value > 1000) throw new Error(`${name} must be a whole number from 1 to 1000`)
  return value
}

function windowSize(text: string | undefined): { width: number; height: number } {
  if (text === undefined || text.trim() === '') return { width: 1920, height: 1080 }
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(text.trim())
  if (!match) throw new Error(`HOBWORK_BROWSER_WINDOW must be like 1920x1080, got ${JSON.stringify(text)}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function loadBrowserSettings(dataDir: string, env: NodeJS.ProcessEnv = process.env): BrowserSettings {
  const mode = (env.HOBWORK_BROWSER ?? '').trim().toLowerCase()
  if (mode !== '' && mode !== 'on' && mode !== 'off') throw new Error('HOBWORK_BROWSER must be on or off')
  const maxTabsPerHob = count('HOBWORK_BROWSER_MAX_TABS', env.HOBWORK_BROWSER_MAX_TABS, DEFAULT_BROWSER_MAX_TABS)
  const channel = env.HOBWORK_BROWSER_CHANNEL?.trim() || undefined
  return {
    dataDir,
    enabled: mode !== 'off',
    idleTimeoutMs: duration('HOBWORK_BROWSER_IDLE', env.HOBWORK_BROWSER_IDLE, DEFAULT_BROWSER_IDLE_MS),
    maxTabsPerHob,
    maxTabs: Math.max(maxTabsPerHob, count('HOBWORK_BROWSER_MAX_TABS_TOTAL', env.HOBWORK_BROWSER_MAX_TABS_TOTAL, DEFAULT_BROWSER_MAX_TABS_TOTAL)),
    headless: env.HOBWORK_BROWSER_HEADLESS === '1',
    locale: env.HOBWORK_BROWSER_LOCALE?.trim() || 'en-US',
    ...(env.HOBWORK_BROWSER_TIMEZONE?.trim() ? { timezoneId: env.HOBWORK_BROWSER_TIMEZONE.trim() } : {}),
    window: windowSize(env.HOBWORK_BROWSER_WINDOW),
    ...(channel ? { channel } : {}),
    ...(env.HOBWORK_BROWSER_EXECUTABLE?.trim() ? { executablePath: env.HOBWORK_BROWSER_EXECUTABLE.trim() } : {}),
    browsersPath: `${dataDir}/browser/browsers`,
    profileDir: `${dataDir}/browser/profile`,
    extensionsDir: `${dataDir}/browser/extensions`,
  }
}
