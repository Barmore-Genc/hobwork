import { expect, test } from 'vitest'
import { startDisplay, type DisplayDeps } from './xvfb.ts'

type Child = ReturnType<DisplayDeps['spawn']>

// An Xvfb stand-in that starts nothing, so a test decides what it says and
// when it exits.
function fakeChild(): {
  child: Child
  killed: NodeJS.Signals[]
  say: (text: string) => void
  fail: (err: NodeJS.ErrnoException) => void
  exit: () => void
} {
  const errors: ((err: NodeJS.ErrnoException) => void)[] = []
  const exits: ((code: number | null) => void)[] = []
  const stderr: ((chunk: Buffer | string) => void)[] = []
  const killed: NodeJS.Signals[] = []
  const child = {
    kill(signal: NodeJS.Signals) {
      killed.push(signal)
    },
    once(event: 'error' | 'exit', listener: (arg: never) => void) {
      if (event === 'error') errors.push(listener as (err: NodeJS.ErrnoException) => void)
      else exits.push(listener as (code: number | null) => void)
    },
    stderr: {
      on(_event: 'data', listener: (chunk: Buffer | string) => void) {
        stderr.push(listener)
      },
    },
  }
  return {
    child: child as Child,
    killed,
    say: (text) => {
      for (const listener of stderr) listener(text)
    },
    fail: (err) => {
      for (const listener of errors) listener(err)
    },
    exit: () => {
      for (const listener of exits) listener(0)
    },
  }
}

// A Linux host without a display: what the host under test has to work with.
function host(overrides: Partial<DisplayDeps> = {}): Partial<DisplayDeps> {
  return {
    platform: 'linux',
    display: undefined,
    exists: () => false,
    read: () => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    },
    remove: () => {},
    running: () => false,
    spawn: () => fakeChild().child,
    sleep: async () => {},
    ...overrides,
  }
}

function locks(entries: Record<number, string>): Pick<DisplayDeps, 'read'> {
  return {
    read: (path) => {
      const match = /\/tmp\/\.X(\d+)-lock$/.exec(path)
      const text = match ? entries[Number(match[1])] : undefined
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return text
    },
  }
}

async function start(options: { deps: Partial<DisplayDeps>; log?: (message: string) => void }) {
  return startDisplay({ width: 1920, height: 1080, log: options.log ?? (() => {}), deps: options.deps })
}

test('runs the browser under its own Xvfb', async () => {
  const logs: string[] = []
  const display = await start({ deps: host({ exists: (path) => path === '/tmp/.X11-unix/X90' }), log: (line) => logs.push(line) })

  expect(display.kind).toBe('display')
  if (display.kind !== 'display') return
  expect(display.display.env.DISPLAY).toBe(':90')
  expect(logs).toEqual(['Running the browser under Xvfb on :90'])
  display.display.stop()
})

test('leaves a display to the X server that owns it', async () => {
  const spawned: number[] = []
  const display = await start({
    deps: host({
      // A live X server whose socket file is gone: its lock is all that is left.
      ...locks({ 90: '   4242\n' }),
      running: (pid) => pid === 4242,
      spawn: (number) => {
        spawned.push(number)
        return fakeChild().child
      },
      exists: (path) => path === '/tmp/.X11-unix/X91',
    }),
  })

  expect(spawned).toEqual([91])
  expect(display.kind === 'display' && display.display.env.DISPLAY).toBe(':91')
})

test('takes a display whose last X server is gone', async () => {
  const spawned: number[] = []
  const display = await start({
    deps: host({
      // Both the lock and the socket of an Xvfb that was killed are left over.
      ...locks({ 90: '   4242\n' }),
      running: () => false,
      exists: (path) => path === '/tmp/.X11-unix/X90',
      spawn: (number) => {
        spawned.push(number)
        return fakeChild().child
      },
    }),
  })

  expect(spawned).toEqual([90])
  expect(display.kind === 'display' && display.display.env.DISPLAY).toBe(':90')
})

test('removes the socket an Xvfb that is gone left behind', async () => {
  const sockets = new Set(['/tmp/.X11-unix/X90'])
  const leftOver: boolean[] = []
  const display = await start({
    deps: host({
      exists: (path) => sockets.has(path),
      remove: (path) => sockets.delete(path),
      spawn: () => {
        leftOver.push(sockets.has('/tmp/.X11-unix/X90'))
        // The Xvfb that starts now binds the socket again.
        sockets.add('/tmp/.X11-unix/X90')
        return fakeChild().child
      },
    }),
  })

  expect(leftOver).toEqual([false])
  expect(display.kind === 'display' && display.display.env.DISPLAY).toBe(':90')
})

test('runs headless only when there is no Xvfb', async () => {
  const child = fakeChild()
  const display = await start({
    deps: host({
      spawn: () => {
        const started = child.child
        setTimeout(() => child.fail(Object.assign(new Error('spawn Xvfb ENOENT'), { code: 'ENOENT' })), 0)
        return started
      },
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
    }),
  })

  expect(display.kind).toBe('headless')
  expect(display.kind === 'headless' && display.reason).toContain('Xvfb is not installed')
})

test('says why Xvfb did not start instead of running headless', async () => {
  const logs: string[] = []
  const attempts: number[] = []
  const started = start({
    deps: host({
      spawn: (number) => {
        attempts.push(number)
        const child = fakeChild()
        setTimeout(() => {
          child.say('Server is already active for display 90\n')
          child.exit()
        }, 0)
        return child.child
      },
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
    }),
    log: (line) => logs.push(line),
  })

  await expect(started).rejects.toThrow(/Xvfb did not start.*Server is already active for display 90/)
  expect(attempts).toEqual([90, 91, 92])
  expect(logs[0]).toContain('Xvfb did not start on :90: it exited, saying: Server is already active for display 90')
})

test('stops an Xvfb that never listened', async () => {
  const child = fakeChild()
  const started = start({ deps: host({ spawn: () => child.child }) })

  await expect(started).rejects.toThrow(/listened on no socket/)
  expect(child.killed).toEqual(['SIGKILL', 'SIGKILL', 'SIGKILL'])
})

test('refuses to start when a running X server holds every display', async () => {
  const held: Record<number, string> = {}
  for (let number = 90; number <= 130; number++) held[number] = `   ${number}00\n`

  await expect(start({ deps: host({ ...locks(held), running: () => true }) })).rejects.toThrow(/holds every display/)
})

test('uses the display a desktop already has', async () => {
  expect((await start({ deps: host({ platform: 'darwin' }) })).kind).toBe('existing')
  expect((await start({ deps: host({ display: ':0' }) })).kind).toBe('existing')
})
