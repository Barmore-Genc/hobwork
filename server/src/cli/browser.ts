import { installBrowser } from '../browser/install.ts'
import { loadConfig } from '../config.ts'

// Installs or refreshes the Chromium and uBlock Origin Lite the host drives.
// Both ride the patchright version in package.json, so an update means bumping
// that dependency and running this again.
const USAGE = 'Usage: pnpm --filter @hobwork/server browser:install'

const command = process.argv[2] ?? 'install'
if (command !== 'install' && command !== 'update') {
  console.error(USAGE)
  process.exit(1)
}

const config = loadConfig()
try {
  const installed = await installBrowser({ dataDir: config.dataDir })
  console.log(`Browser installed: ${installed.browser}`)
  if (installed.extension) console.log(`Extension installed: ${installed.extension}`)
  else console.log('uBlock Origin Lite was not installed; the browser runs without it.')
  console.log(`Data dir: ${config.dataDir}/browser`)
} catch (err) {
  console.error(`Could not install the browser: ${(err as Error).message}`)
  process.exitCode = 1
}
