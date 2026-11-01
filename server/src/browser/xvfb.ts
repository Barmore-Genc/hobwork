import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

// A headful browser needs a display, and a server has none. Headless is the
// alternative, but Chrome reports "HeadlessChrome" in the user agent there,
// which patchright's maintainer calls unfixable without a custom build
// (patchright#82), so Xvfb is the way to run one on a box without a screen.
export type Display = { env: NodeJS.ProcessEnv; stop: () => void }

const FIRST_DISPLAY = 90
const LAST_DISPLAY = 130
// Xvfb takes a moment to create its socket.
const WAIT_STEPS = 100
const WAIT_STEP_MS = 50

function freeDisplay(): number | undefined {
  for (let number = FIRST_DISPLAY; number <= LAST_DISPLAY; number++) {
    if (!existsSync(`/tmp/.X11-unix/X${number}`)) return number
  }
  return undefined
}

export async function startDisplay(options: {
  width: number
  height: number
  log: (message: string) => void
}): Promise<Display | undefined> {
  // macOS and Linux desktops have one; only a headless Linux host gets Xvfb.
  if (process.platform !== 'linux' || process.env.DISPLAY) return undefined
  const number = freeDisplay()
  if (number === undefined) {
    options.log(`No free X display number between :${FIRST_DISPLAY} and :${LAST_DISPLAY}, running headless`)
    return undefined
  }
  const socket = `/tmp/.X11-unix/X${number}`
  let child: ChildProcess
  try {
    child = spawn('Xvfb', [`:${number}`, '-screen', '0', `${options.width}x${options.height}x24`, '-nolisten', 'tcp'], {
      stdio: 'ignore',
    })
  } catch {
    options.log('Xvfb is not installed, running headless')
    return undefined
  }
  let gone = false
  child.once('error', () => {
    gone = true
  })
  child.once('exit', () => {
    gone = true
  })
  for (let step = 0; step < WAIT_STEPS; step += 1) {
    if (gone) {
      options.log('Xvfb did not start, running headless')
      return undefined
    }
    if (existsSync(socket)) {
      options.log(`Running the browser under Xvfb on :${number}`)
      return {
        env: { ...process.env, DISPLAY: `:${number}` },
        stop: () => child.kill('SIGTERM'),
      }
    }
    await delay(WAIT_STEP_MS)
  }
  child.kill('SIGKILL')
  options.log(`Xvfb did not answer on :${number}, running headless`)
  return undefined
}
