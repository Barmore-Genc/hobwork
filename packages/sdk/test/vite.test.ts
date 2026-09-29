import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBuilder } from 'vite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { handlerEntries, hobworkViteConfig } from '../src/vite.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hobwork-vite-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

test('takes the handlers from a hobwork.json with comments', () => {
  write({
    'hobwork.json': `{
  // Answers the dashboard.
  "routes": { "GET /greeting": { "handler": "./src/greeting-route.ts" } },
  "crons": { "tick": { "schedule": "* * * * *", "handler": "src/jobs/tick.mts", }, },
}`,
  })
  expect(handlerEntries(dir)).toEqual({ 'src/greeting-route': './src/greeting-route.ts', 'src/jobs/tick': 'src/jobs/tick.mts' })
})

test('builds the dashboard and each handler', async () => {
  write({
    'hobwork.json': '{\n  // Greets.\n  "routes": { "GET /greeting": { "handler": "src/greeting-route.ts" } },\n}\n',
    'src/greeting-route.ts': "const greeting: string = 'hello'\nexport default () => ({ greeting })\n",
    'index.html': '<!doctype html><div id="root"></div><script type="module" src="/ui/main.ts"></script>',
    'ui/main.ts': "document.getElementById('root')!.textContent = 'hi'\n",
  })
  const builder = await createBuilder({ ...hobworkViteConfig(dir), root: dir, configFile: false, logLevel: 'silent' })
  await builder.buildApp()

  expect(existsSync(join(dir, 'dist/index.html'))).toBe(true)
  const handler = await import(join(dir, 'dist/handlers/src/greeting-route.js'))
  expect(handler.default()).toEqual({ greeting: 'hello' })
})
