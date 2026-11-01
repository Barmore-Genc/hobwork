import { expect, test, vi } from 'vitest'
import { sweepStaleDisplays, type SweepDeps } from './sweep.ts'
import { lockPath, socketPath } from './xvfb.ts'

const OWN = '0::/system.slice/hobwork.service'
const XVFB = ['Xvfb', ':90', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp']

type Proc = { pid: number; args: string[]; cgroup?: string; socket?: boolean }

// A /proc to read, and processes that go away when they are signalled.
function host(procs: Proc[], options: { stubborn?: number[]; cgroups?: Record<string, string> } = {}): {
  deps: Partial<SweepDeps>
  killed: { pid: number; signal: string }[]
  removed: string[]
} {
  const cgroups: Record<string, string> = { '/proc/self/cgroup': OWN, ...options.cgroups }
  const files = new Map<string, string>()
  const sockets = new Set<string>()
  for (const [path, text] of Object.entries(cgroups)) files.set(path, text)
  for (const proc of procs) {
    files.set(`/proc/${proc.pid}/cgroup`, proc.cgroup ?? cgroups['/proc/self/cgroup'] ?? OWN)
    files.set(`/proc/${proc.pid}/cmdline`, `${proc.args.join('\0')}\0`)
    const display = proc.args[1]?.slice(1)
    if (proc.socket !== false && display !== undefined && /^\d+$/.test(display)) sockets.add(socketPath(Number(display)))
  }
  const alive = new Set(procs.map((proc) => proc.pid))
  const killed: { pid: number; signal: string }[] = []
  const removed: string[] = []
  return {
    killed,
    removed,
    deps: {
      platform: 'linux',
      self: 1000,
      // Real /proc holds plenty that is not a pid.
      list: () => ['self', 'sys', 'net', ...procs.map((proc) => String(proc.pid))],
      read: (path) => files.get(path),
      exists: (path) => sockets.has(path),
      remove: (path) => {
        removed.push(path)
        sockets.delete(path)
      },
      kill: (pid, signal) => {
        killed.push({ pid, signal })
        if (signal === 'SIGKILL' || options.stubborn?.includes(pid) !== true) alive.delete(pid)
      },
      running: (pid) => alive.has(pid),
      sleep: async () => {},
    },
  }
}

test('stops an Xvfb an earlier browser left behind', async () => {
  const { deps, killed, removed } = host([{ pid: 200, args: XVFB }])
  const log = vi.fn()

  const freed = await sweepStaleDisplays({ log, deps })

  expect(freed).toEqual([90])
  expect(killed).toEqual([{ pid: 200, signal: 'SIGTERM' }])
  expect(removed).toEqual([lockPath(90), socketPath(90)])
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/stopped 1 Xvfb server .*:90$/))
})

test('frees several displays, lowest first', async () => {
  const { deps } = host([
    { pid: 200, args: ['Xvfb', ':130', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'] },
    { pid: 201, args: ['Xvfb', ':97', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'] },
  ])

  expect(await sweepStaleDisplays({ log: () => {}, deps })).toEqual([97, 130])
})

test('leaves an Xvfb of another cgroup alone', async () => {
  const { deps, killed } = host([{ pid: 200, args: XVFB, cgroup: '0::/system.slice/other.service' }])
  const log = vi.fn()

  expect(await sweepStaleDisplays({ log, deps })).toEqual([])
  expect(killed).toEqual([])
  expect(log).not.toHaveBeenCalled()
})

test('leaves an Xvfb whose arguments differ alone', async () => {
  const values = (display: string) => ['Xvfb', display, '-screen', '0']
  const { deps, killed } = host([
    // A desktop Xvfb of another depth, an `xvfb-run` one, one with extra flags.
    { pid: 200, args: [...values(':91'), '1280x1024x16', '-nolisten', 'tcp'] },
    { pid: 201, args: [...values(':92'), '1920x1080x24'] },
    { pid: 202, args: [...values(':93'), '1920x1080x24', '-nolisten', 'tcp', '-ac'] },
    { pid: 203, args: ['/usr/bin/Xvfb', ':94', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'] },
    // Our shape, but outside the range this host hands out.
    { pid: 204, args: ['Xvfb', ':7', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'] },
    // Our shape, but started outside this host's private /tmp.
    { pid: 205, args: ['Xvfb', ':95', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], socket: false },
  ])

  expect(await sweepStaleDisplays({ log: () => {}, deps })).toEqual([])
  expect(killed).toEqual([])
})

test('leaves this process and the ones it keeps alone', async () => {
  const { deps, killed } = host([
    { pid: 1000, args: XVFB },
    { pid: 201, args: ['Xvfb', ':91', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'] },
  ])

  expect(await sweepStaleDisplays({ log: () => {}, keep: [201], deps })).toEqual([])
  expect(killed).toEqual([])
})

test('kills an Xvfb that ignores SIGTERM', async () => {
  const { deps, killed } = host([{ pid: 200, args: XVFB }], { stubborn: [200] })

  expect(await sweepStaleDisplays({ log: () => {}, deps })).toEqual([90])
  expect(killed).toEqual([
    { pid: 200, signal: 'SIGTERM' },
    { pid: 200, signal: 'SIGKILL' },
  ])
})

test('reads cgroup v1 as the controller sets it is', async () => {
  const own = '12:cpu,cpuacct:/system.slice/hobwork.service\n4:memory:/system.slice/hobwork.service\n'
  const { deps, killed } = host(
    [
      // The same lines in another order, which is the same cgroup.
      { pid: 200, args: XVFB, cgroup: '4:memory:/system.slice/hobwork.service\n12:cpu,cpuacct:/system.slice/hobwork.service\n' },
      // Another controller set is another cgroup.
      { pid: 201, args: ['Xvfb', ':91', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], cgroup: '12:cpu:/system.slice/hobwork.service\n4:memory:/system.slice/hobwork.service\n' },
    ],
    { cgroups: { '/proc/self/cgroup': own } },
  )

  expect(await sweepStaleDisplays({ log: () => {}, deps })).toEqual([90])
  expect(killed).toEqual([{ pid: 200, signal: 'SIGTERM' }])
})

test('survives a /proc it cannot read', async () => {
  const log = vi.fn()
  const unreadable: Partial<SweepDeps> = { platform: 'linux', read: () => undefined, list: () => [] }
  expect(await sweepStaleDisplays({ log, deps: unreadable })).toEqual([])
  expect(log).not.toHaveBeenCalled()

  const noProc: Partial<SweepDeps> = {
    platform: 'linux',
    read: () => undefined,
    list: () => {
      throw Object.assign(new Error('ENOENT: /proc'), { code: 'ENOENT' })
    },
  }
  expect(await sweepStaleDisplays({ log, deps: noProc })).toEqual([])

  const elsewhere: Partial<SweepDeps> = { platform: 'darwin' }
  expect(await sweepStaleDisplays({ log, deps: elsewhere })).toEqual([])
})

test('does nothing and says nothing when there is nothing to free', async () => {
  const { deps, killed } = host([])
  const log = vi.fn()

  expect(await sweepStaleDisplays({ log, deps })).toEqual([])
  expect(killed).toEqual([])
  expect(log).not.toHaveBeenCalled()
})
