import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

// A headful browser needs a display, and a server has none. Headless is the
// alternative, but Chrome reports "HeadlessChrome" in the user agent there,
// which patchright's maintainer calls unfixable without a custom build
// (patchright#82), so Xvfb is the way to run one on a box without a screen.
export type Display = { env: NodeJS.ProcessEnv; stop: () => void }

export type DisplayStart =
  // A display of our own, and the environment that reaches it.
  | { kind: 'display'; display: Display }
  // There is a display already: macOS, or a Linux desktop that sets DISPLAY.
  | { kind: 'existing' }
  // Nothing here can show a window, so a headful browser is impossible.
  | { kind: 'headless'; reason: string }

export const FIRST_DISPLAY = 90
export const LAST_DISPLAY = 130
// One number can fail while the next one works, so trying a few beats falling
// back to a browser without a display at the first hiccup.
const ATTEMPTS = 3
// Xvfb takes a moment to create its socket.
const WAIT_STEPS = 100
const WAIT_STEP_MS = 50
// What Xvfb said goes into one log line, so keep a line's worth of it.
const MAX_REASON_CHARS = 300

type XvfbChild = {
  kill: (signal: NodeJS.Signals) => void
  once: ((event: 'error', listener: (err: NodeJS.ErrnoException) => void) => void) &
    ((event: 'exit', listener: (code: number | null) => void) => void)
  stderr: { on: (event: 'data', listener: (chunk: Buffer | string) => void) => void } | null
}

export type DisplayDeps = {
  platform: NodeJS.Platform
  display: string | undefined
  exists: (path: string) => boolean
  read: (path: string) => string
  remove: (path: string) => void
  // Whether a pid is a process that is still there.
  running: (pid: number) => boolean
  spawn: (number: number, size: string) => XvfbChild
  sleep: (ms: number) => Promise<void>
}

const realDeps: DisplayDeps = {
  platform: process.platform,
  display: process.env.DISPLAY,
  exists: existsSync,
  read: (path) => readFileSync(path, 'utf8'),
  remove: (path) => rmSync(path, { force: true }),
  running: processRunning,
  // Xvfb says why it will not start ("Server is already active for display 90",
  // a library it cannot load) on stderr, and that is the only way to know.
  spawn: (number, size) =>
    spawn('Xvfb', [`:${number}`, '-screen', '0', size, '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe'] }),
  sleep: (ms) => delay(ms),
}

// Through EPERM a process is there, just not ours to signal.
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function socketPath(number: number): string {
  return `/tmp/.X11-unix/X${number}`
}

export function lockPath(number: number): string {
  return `/tmp/.X${number}-lock`
}

// An X server writes its pid to /tmp/.X<n>-lock before it listens, and refuses
// a number whose lock names a living process. A socket file alone is a
// leftover: the next server removes it and takes the number, so a dead server
// does not keep its display.
function lockPid(deps: DisplayDeps, number: number): number | undefined {
  try {
    const pid = Number.parseInt(deps.read(lockPath(number)).trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function freeDisplays(deps: DisplayDeps): number[] {
  const free: number[] = []
  for (let number = FIRST_DISPLAY; number <= LAST_DISPLAY; number++) {
    const pid = lockPid(deps, number)
    if (pid !== undefined && deps.running(pid)) continue
    free.push(number)
  }
  return free
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type Launch = { display: Display; error?: undefined; missing?: undefined } | { display?: undefined; error: string; missing: boolean }

async function launch(number: number, size: string, deps: DisplayDeps): Promise<Launch> {
  // The socket of a server that is gone outlives it, and a start is known to
  // have worked by that socket appearing, so the leftover has to go first.
  if (deps.exists(socketPath(number))) deps.remove(socketPath(number))
  let child: XvfbChild
  try {
    child = deps.spawn(number, size)
  } catch (err) {
    return { error: message(err), missing: (err as NodeJS.ErrnoException).code === 'ENOENT' }
  }
  let said = ''
  child.stderr?.on('data', (chunk) => {
    said = (said + String(chunk)).slice(0, MAX_REASON_CHARS).trim()
  })
  let failure: string | undefined
  let missing = false
  // A missing Xvfb arrives here rather than as a throw from spawn.
  child.once('error', (err) => {
    missing = err.code === 'ENOENT'
    failure ??= missing ? 'there is no Xvfb' : message(err)
  })
  child.once('exit', () => {
    failure ??= 'it exited'
  })
  for (let step = 0; step < WAIT_STEPS; step += 1) {
    if (failure !== undefined) return { error: said === '' ? failure : `${failure}, saying: ${said}`, missing }
    if (deps.exists(socketPath(number))) {
      return {
        display: {
          env: { ...process.env, DISPLAY: `:${number}` },
          stop: () => child.kill('SIGTERM'),
        },
      }
    }
    await deps.sleep(WAIT_STEP_MS)
  }
  child.kill('SIGKILL')
  return { error: `it kept running but listened on no socket for ${(WAIT_STEPS * WAIT_STEP_MS) / 1000} seconds`, missing: false }
}

export async function startDisplay(options: {
  width: number
  height: number
  log: (message: string) => void
  // Tests replace what a host provides; on a host these are the real thing.
  deps?: Partial<DisplayDeps>
}): Promise<DisplayStart> {
  const deps = { ...realDeps, ...options.deps }
  // macOS and Linux desktops have one; only a headless Linux host gets Xvfb.
  if (deps.platform !== 'linux' || deps.display) return { kind: 'existing' }
  const free = freeDisplays(deps)
  if (free.length === 0) {
    throw new Error(`An X server of another process holds every display from :${FIRST_DISPLAY} to :${LAST_DISPLAY}`)
  }
  const reasons: string[] = []
  for (const number of free.slice(0, ATTEMPTS)) {
    const started = await launch(number, `${options.width}x${options.height}x24`, deps)
    if (started.display !== undefined) {
      options.log(`Running the browser under Xvfb on :${number}`)
      return { kind: 'display', display: started.display }
    }
    if (started.missing) {
      return { kind: 'headless', reason: 'Xvfb is not installed. Install Xvfb on a Linux host, or run where there is a display' }
    }
    options.log(`Xvfb did not start on :${number}: ${started.error}`)
    reasons.push(`:${number}: ${started.error}`)
  }
  // A display that does not work is not a host that has none: a headful launch
  // without one fails inside Playwright, and headless here would hide it.
  throw new Error(`Xvfb did not start. ${reasons.join('. ')}`)
}
