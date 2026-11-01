import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { FIRST_DISPLAY, LAST_DISPLAY, lockPath, processRunning, socketPath } from './xvfb.ts'

// One Xvfb runs per browser, and the browser stops it. A browser that closes
// behind our back, or a host that was killed, leaves an Xvfb running for the
// life of the unit, and its display number never comes back. There are 41 of
// them, so the host sweeps its own leftovers before it starts a browser.

export type SweepDeps = {
  platform: NodeJS.Platform
  self: number
  list: (dir: string) => string[]
  // undefined for what it may not read: another user's process, or one that is
  // gone already.
  read: (path: string) => string | undefined
  exists: (path: string) => boolean
  remove: (path: string) => void
  kill: (pid: number, signal: NodeJS.Signals) => void
  running: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
}

const realDeps: SweepDeps = {
  platform: process.platform,
  self: process.pid,
  list: (dir) => readdirSync(dir),
  read: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  },
  exists: existsSync,
  remove: (path) => rmSync(path, { force: true }),
  kill: (pid, signal) => process.kill(pid, signal),
  running: processRunning,
  sleep: (ms) => delay(ms),
}

// Xvfb answers SIGTERM; a server stuck enough to ignore it is killed.
const TERM_STEPS = 20
const KILL_STEPS = 10
const WAIT_STEP_MS = 100

const PID = /^\d+$/
// Xvfb's own syntax: `Xvfb :90 -screen 0 1920x1080x24 -nolisten tcp`.
const DISPLAY = /^:(\d+)$/
const SCREEN = /^\d{3,5}x\d{3,5}x24$/

// cgroup v2 writes one `0::/path` line, v1 writes `<id>:<controllers>:<path>`
// for each controller, so it is the controller and path pairs that have to
// match. Two processes in one cgroup write the same lines.
function cgroup(text: string | undefined): string | undefined {
  const lines = text?.split('\n').map((line) => line.trim()).filter((line) => line !== '') ?? []
  if (lines.length === 0) return undefined
  return lines.map((line) => line.replace(/^\d+:/, '')).sort().join(';')
}

// The arguments, not a piece of the command line: another Xvfb on this box
// (`-screen 0 1280x1024x16`, an `xvfb-run` wrapper) is not one of ours.
function displayOf(args: string[]): number | undefined {
  if (args.length !== 7) return undefined
  const [command, display, screen, screenNumber, geometry, noListen, transport] = args
  if (command !== 'Xvfb' || screen !== '-screen' || screenNumber !== '0') return undefined
  if (geometry === undefined || !SCREEN.test(geometry)) return undefined
  if (noListen !== '-nolisten' || transport !== 'tcp') return undefined
  const match = DISPLAY.exec(display ?? '')
  if (match === null || match[1] === undefined) return undefined
  const number = Number(match[1])
  return number >= FIRST_DISPLAY && number <= LAST_DISPLAY ? number : undefined
}

function argsOf(deps: SweepDeps, pid: number): string[] {
  const text = deps.read(`/proc/${pid}/cmdline`)
  if (text === undefined) return []
  return text.split('\0').filter((arg) => arg !== '')
}

function pids(deps: SweepDeps): number[] {
  try {
    return deps.list('/proc')
      .filter((entry) => PID.test(entry))
      .map(Number)
  } catch {
    return []
  }
}

// SIGTERM frees it, and the display number with it. A pid that cannot be
// signalled at all and is still there is not ours to stop.
async function stop(pid: number, deps: SweepDeps): Promise<boolean> {
  try {
    deps.kill(pid, 'SIGTERM')
  } catch {
    return !deps.running(pid)
  }
  for (let step = 0; step < TERM_STEPS; step += 1) {
    if (!deps.running(pid)) return true
    await deps.sleep(WAIT_STEP_MS)
  }
  try {
    deps.kill(pid, 'SIGKILL')
  } catch {
    return true
  }
  for (let step = 0; step < KILL_STEPS; step += 1) {
    if (!deps.running(pid)) break
    await deps.sleep(WAIT_STEP_MS)
  }
  return true
}

// The displays this sweep freed, from :90.
export async function sweepStaleDisplays(options: {
  log: (message: string) => void
  // Pids the host runs on purpose, which nothing runs but startDisplay.
  keep?: number[]
  deps?: Partial<SweepDeps>
}): Promise<number[]> {
  const deps = { ...realDeps, ...options.deps }
  // /proc is Linux's, and a host elsewhere has no Xvfb of ours to clean up.
  if (deps.platform !== 'linux') return []
  const own = cgroup(deps.read('/proc/self/cgroup'))
  if (own === undefined) return []
  const keep = new Set([deps.self, ...(options.keep ?? [])])

  const found: { pid: number; display: number }[] = []
  for (const pid of pids(deps)) {
    if (keep.has(pid)) continue
    const display = displayOf(argsOf(deps, pid))
    if (display === undefined) continue
    // A socket in our own /tmp proves the Xvfb was started here: the unit's
    // PrivateTmp keeps another host's displays out of reach.
    if (!deps.exists(socketPath(display))) continue
    if (cgroup(deps.read(`/proc/${pid}/cgroup`)) !== own) continue
    found.push({ pid, display })
  }

  const freed: number[] = []
  for (const { pid, display } of found) {
    if (!(await stop(pid, deps))) continue
    // What an Xvfb that was killed this way leaves behind would hold the
    // number against the next one.
    deps.remove(lockPath(display))
    deps.remove(socketPath(display))
    freed.push(display)
  }
  freed.sort((left, right) => left - right)
  if (freed.length > 0) {
    options.log(
      `Browser: stopped ${freed.length} Xvfb ${freed.length === 1 ? 'server' : 'servers'} left behind by earlier browsers, freeing ${freed.map((number) => `:${number}`).join(' ')}`,
    )
  }
  return freed
}
