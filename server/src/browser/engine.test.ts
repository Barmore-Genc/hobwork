import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vitest'
import type { EngineOptions } from './engine.ts'
import { loadBrowserSettings } from './settings.ts'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  startDisplay: vi.fn(),
}))

// patchright is not installed everywhere and downloads nothing here, so the
// launch is a fake that records what the host would have asked for.
vi.mock('patchright', () => ({
  chromium: { executablePath: () => '/nonexistent/chrome', launchPersistentContext: mocks.launch },
}))

vi.mock('./xvfb.ts', () => ({ startDisplay: mocks.startDisplay }))

const { patchrightEngine } = await import('./engine.ts')

beforeEach(() => {
  mocks.launch.mockReset()
  mocks.startDisplay.mockReset()
})

type Page = {
  url: () => string
  on: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function fakeContext(): {
  route: ReturnType<typeof vi.fn>
  pages: () => Page[]
  newPage: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
} {
  const pages: Page[] = []
  return {
    route: vi.fn(async () => {}),
    pages: () => pages,
    newPage: vi.fn(async () => {
      const page: Page = {
        url: () => 'about:blank',
        on: vi.fn(),
        close: vi.fn(async () => {
          const at = pages.indexOf(page)
          if (at >= 0) pages.splice(at, 1)
        }),
      }
      pages.push(page)
      return page
    }),
    on: vi.fn(),
    close: vi.fn(async () => {}),
  }
}

function options(env: Record<string, string> = {}): {
  options: EngineOptions
  logs: string[]
  closed: string[]
} {
  const logs: string[] = []
  const closed: string[] = []
  const settings = loadBrowserSettings(mkdtempSync(join(tmpdir(), 'hobwork-engine-')), env)
  return {
    logs,
    closed,
    options: {
      settings,
      navigationProblem: () => undefined,
      onBlocked: () => {},
      onClosed: (reason) => closed.push(reason),
      log: (level, message) => logs.push(`${level} ${message}`),
    },
  }
}

test('runs headless when there is no display to run under', async () => {
  mocks.startDisplay.mockResolvedValue({ kind: 'headless', reason: 'Xvfb is not installed' })
  mocks.launch.mockResolvedValue(fakeContext())
  const { options: given, logs } = options()

  const engine = await patchrightEngine(given)

  expect(mocks.startDisplay).toHaveBeenCalled()
  const launchOptions = mocks.launch.mock.calls[0]![1]
  expect(launchOptions.headless).toBe(true)
  expect(launchOptions.env).toBeUndefined()
  expect(logs).toContainEqual(expect.stringContaining('running headless'))
  await engine.close()
})

test('runs the browser on the display it was given', async () => {
  const stop = vi.fn()
  mocks.startDisplay.mockResolvedValue({ kind: 'display', display: { env: { DISPLAY: ':91' }, stop } })
  mocks.launch.mockResolvedValue(fakeContext())
  const { options: given, logs } = options()

  const engine = await patchrightEngine(given)

  const launchOptions = mocks.launch.mock.calls[0]![1]
  expect(launchOptions.headless).toBe(false)
  expect(launchOptions.env.DISPLAY).toBe(':91')
  expect(logs).not.toContainEqual(expect.stringContaining('running headless'))
  await engine.close()
  expect(stop).toHaveBeenCalled()
})

test('stops the display when the browser does not start', async () => {
  const stop = vi.fn()
  mocks.startDisplay.mockResolvedValue({ kind: 'display', display: { env: { DISPLAY: ':91' }, stop } })
  mocks.launch.mockRejectedValue(new Error('browserType.launchPersistentContext: Target page, context or browser has been closed'))
  const { options: given } = options()

  await expect(patchrightEngine(given)).rejects.toThrow(/Target page, context or browser has been closed/)
  expect(stop).toHaveBeenCalled()
})

test('stops the display when the browser closes behind our back', async () => {
  const stop = vi.fn()
  const context = fakeContext()
  mocks.startDisplay.mockResolvedValue({ kind: 'display', display: { env: { DISPLAY: ':91' }, stop } })
  mocks.launch.mockResolvedValue(context)
  const { options: given, closed } = options()

  await patchrightEngine(given)
  const onClose = context.on.mock.calls.find(([event]) => event === 'close')![1] as () => void
  onClose()

  expect(stop).toHaveBeenCalled()
  expect(closed).toEqual(['The browser closed'])
})

test('leaves a page open so a closed tab does not end the browser', async () => {
  mocks.startDisplay.mockResolvedValue({ kind: 'existing' })
  const context = fakeContext()
  mocks.launch.mockResolvedValue(context)
  const { options: given, closed } = options()

  const engine = await patchrightEngine(given)
  const tab = await engine.open()
  await tab.close()

  expect(context.pages()).toHaveLength(1)
  expect(closed).toEqual([])
  await engine.close()
})

test('does not look for a display when it was told to run headless', async () => {
  mocks.startDisplay.mockClear()
  mocks.launch.mockResolvedValue(fakeContext())
  const { options: given } = options({ HOBWORK_BROWSER_HEADLESS: '1' })

  const engine = await patchrightEngine(given)

  expect(mocks.startDisplay).not.toHaveBeenCalled()
  expect(mocks.launch.mock.calls[0]![1].headless).toBe(true)
  await engine.close()
})
