import { execFile } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { browserExecutable, extensionDir, useBrowsersPath } from './engine.ts'
import { loadBrowserSettings, type BrowserSettings } from './settings.ts'

const run = promisify(execFile)

// uBlock Origin Lite, the MV3 build. Its rules are declarativeNetRequest, so a
// page cannot observe it. It needs the bundled Chromium: Google Chrome and Edge
// removed the flags that side-load an unpacked extension.
const UBLOCK_REPO = 'uBlockOrigin/uBOL-home'
export const UBLOCK_DIR = 'ublock-origin-lite'
const DOWNLOAD_TIMEOUT_MS = 120_000

function readdir(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true })
}

// The directory holding the extension's manifest.json, which is not always the
// zip's root.
function findManifest(dir: string): string | undefined {
  const entries = readdir(dir)
  if (entries.some((entry) => entry.isFile() && entry.name === 'manifest.json')) return dir
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = findManifest(join(dir, entry.name))
    if (found !== undefined) return found
  }
  return undefined
}

async function download(url: string, path: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || res.body === null) throw new Error(`${url} answered ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path))
}

export type InstallResult = { browser: string; extension?: string }

// The newest uBlock Origin Lite, unpacked where the browser looks for it, and
// the version recorded next to it.
export async function installExtension(settings: BrowserSettings, log: (message: string) => void): Promise<string | undefined> {
  const res = await fetch(`https://api.github.com/repos/${UBLOCK_REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the newest uBlock Origin Lite release`)
  const release = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] }
  const asset = release.assets?.find((entry) => entry.name.endsWith('.chromium.zip'))
  if (!asset) throw new Error(`The uBlock Origin Lite release ${release.tag_name ?? ''} has no chromium zip`)

  const work = await mkdtemp(join(tmpdir(), 'hobwork-ubol-'))
  try {
    const zip = join(work, asset.name)
    log(`Downloading uBlock Origin Lite ${release.tag_name ?? ''}`)
    await download(asset.browser_download_url, zip)
    const unpacked = join(work, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    try {
      await run('unzip', ['-q', '-o', zip, '-d', unpacked])
    } catch (err) {
      throw new Error(`Could not unzip the extension (is unzip installed?): ${(err as Error).message}`)
    }
    const manifestDir = findManifest(unpacked)
    if (manifestDir === undefined) throw new Error(`${asset.name} has no manifest.json`)

    const target = join(settings.extensionsDir, UBLOCK_DIR)
    mkdirSync(settings.extensionsDir, { recursive: true, mode: 0o700 })
    rmSync(target, { recursive: true, force: true })
    await cp(manifestDir, target, { recursive: true })
    const version = (JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')) as { version?: string }).version
    writeFileSync(
      join(settings.extensionsDir, `${UBLOCK_DIR}.json`),
      `${JSON.stringify({ version, tag: release.tag_name, installedAt: new Date().toISOString() }, null, 2)}\n`,
    )
    return `${UBLOCK_DIR} ${version ?? release.tag_name ?? ''}`
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Chromium from patchright's own registry, then uBlock Origin Lite. Both go
// under the data dir, so nothing lands in the repository or in a hob.
export async function installBrowser(options: { dataDir: string; log?: (message: string) => void }): Promise<InstallResult> {
  const log = options.log ?? ((message: string) => console.log(message))
  const settings = loadBrowserSettings(options.dataDir)
  const browsersPath = useBrowsersPath(settings)
  mkdirSync(browsersPath, { recursive: true, mode: 0o700 })

  log('Downloading Chromium')
  // patchright does not export cli.js, so it is found next to the entry point.
  const cli = join(dirname(fileURLToPath(import.meta.resolve('patchright'))), 'cli.js')
  await run(process.execPath, [cli, 'install', 'chromium'], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
    maxBuffer: 16 * 1024 * 1024,
  })

  const extension = await installExtension(settings, log)
  const executable = await browserExecutable(settings)
  if (executable === undefined) {
    throw new Error(`Chromium was downloaded into ${browsersPath} but patchright cannot find it`)
  }
  return { browser: executable, ...(extension === undefined ? {} : { extension }) }
}

// Where the extension is now, or undefined when it was never installed.
export function installedExtension(dataDir: string): string | undefined {
  return extensionDir(loadBrowserSettings(dataDir))
}
