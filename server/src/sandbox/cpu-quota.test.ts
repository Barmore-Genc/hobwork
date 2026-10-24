import { expect, test } from 'vitest'
import {
  assertCpuShare,
  capVmCpu,
  cgroupMount,
  cpuQuota,
  cpuShareProblem,
  detectCpuQuota,
  probeCpuQuota,
  type CgroupIo,
  type CpuQuota,
} from './cpu-quota.ts'
import { createGondolinSandbox } from './gondolin.ts'

type Fake = CgroupIo & { readonly writes: [string, string][], readonly dirs: string[] }

const notFound = (path: string) => new Error(`ENOENT: no such file or directory, open '${path}'`)

function fakeIo(options: {
  files?: Record<string, string>
  tree?: number[]
  failWrite?: (path: string, value: string) => string | undefined
} = {}): Fake {
  const files = new Map(Object.entries(options.files ?? {}))
  const procs = new Map<string, number[]>()
  const writes: [string, string][] = []
  const dirs: string[] = []
  return {
    writes,
    dirs,
    read(path) {
      if (path.endsWith('/cgroup.procs')) return (procs.get(path) ?? []).join('\n')
      const value = files.get(path)
      if (value === undefined) throw notFound(path)
      return value
    },
    write(path, value) {
      const failure = options.failWrite?.(path, value)
      if (failure) throw new Error(failure)
      writes.push([path, value])
      if (path.endsWith('/cgroup.procs')) procs.set(path, [...(procs.get(path) ?? []), Number(value)])
      else files.set(path, value)
    },
    mkdir(path) {
      dirs.push(path)
    },
    remove(path) {
      dirs.splice(dirs.indexOf(path), 1)
    },
    tree: () => options.tree ?? [4242],
  }
}

const MOUNTINFO = '36 25 0:32 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:4 - cgroup2 cgroup2 rw,nsdelegate\n'
const SELF = '0::/user.slice/user-1000.slice/app.slice/hobwork.service\n'
const DELEGATED = '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/hobwork.service'

test('finds the cgroup v2 mount and this process in it', () => {
  expect(cgroupMount(MOUNTINFO, SELF)).toEqual({ mount: '/sys/fs/cgroup', self: DELEGATED })
  expect(cgroupMount(MOUNTINFO, '0::/\n')).toEqual({ mount: '/sys/fs/cgroup', self: '/sys/fs/cgroup' })
  expect(cgroupMount('30 24 0:26 / /proc rw - proc proc rw\n', SELF)).toBeUndefined()
})

test('a host that is not Linux has no quota to give', () => {
  const io = fakeIo()
  expect(probeCpuQuota('darwin', io)).toEqual({ mode: 'none', reason: 'it does not run Linux' })
  expect(io.writes).toEqual([])
})

test('reasons say what is missing', () => {
  const noMount = fakeIo({ files: { '/proc/self/mountinfo': '30 24 0:26 / /proc rw - proc proc rw\n', '/proc/self/cgroup': SELF } })
  expect(probeCpuQuota('linux', noMount)).toEqual({ mode: 'none', reason: 'it has no cgroup v2 mount' })

  const noCpu = fakeIo({
    files: { '/proc/self/mountinfo': MOUNTINFO, '/proc/self/cgroup': SELF, [`${DELEGATED}/cgroup.controllers`]: 'cpuset io memory' },
  })
  expect(probeCpuQuota('linux', noCpu)).toEqual({ mode: 'none', reason: 'its cgroup v2 has no cpu controller' })
})

test('parks the host in a child cgroup when it has to', () => {
  const io = fakeIo({
    files: { '/proc/self/mountinfo': MOUNTINFO, '/proc/self/cgroup': SELF, [`${DELEGATED}/cgroup.controllers`]: 'cpu io memory' },
    failWrite: (path) => (path.endsWith('cpu.max') && !path.includes('/host') && !io.dirs.includes(`${DELEGATED}/host`))
      ? 'ENOENT: no such file or directory'
      : undefined,
  })
  expect(probeCpuQuota('linux', io)).toEqual({ mode: 'cgroup', base: DELEGATED })
  expect(io.writes).toContainEqual([`${DELEGATED}/host/cgroup.procs`, String(process.pid)])
  expect(io.writes).toContainEqual([`${DELEGATED}/cgroup.subtree_control`, '+cpu'])
})

test('a quota that stays unwritable leaves no quota at all', () => {
  const io = fakeIo({
    files: { '/proc/self/mountinfo': MOUNTINFO, '/proc/self/cgroup': SELF, [`${DELEGATED}/cgroup.controllers`]: 'cpu' },
    failWrite: (path) => (path.endsWith('cpu.max') || path.endsWith('cgroup.procs') ? 'EROFS: read-only file system' : undefined),
  })
  const quota = detectCpuQuota([[DELEGATED, true], ['/sys/fs/cgroup', false]], io)
  expect(quota.mode).toBe('none')
  expect(quota).toMatchObject({ reason: expect.stringContaining('cannot set a cgroup CPU quota') })
})

test('a share is only allowed where the host can hold a VM to it', () => {
  const cgroup: CpuQuota = { mode: 'cgroup', base: '/sys/fs/cgroup' }
  const none: CpuQuota = { mode: 'none', reason: 'it does not run Linux' }
  expect(cpuShareProblem(1, none)).toBeUndefined()
  expect(cpuShareProblem(0.5, cgroup)).toBeUndefined()
  expect(cpuShareProblem(0.5, none)).toBe(
    'this host cannot cap a VM at 0.5 vCPUs, because it does not run Linux. Ask for a whole number of vCPUs, at least 1.',
  )
  expect(() => assertCpuShare(0.5, 'resources.runtime.cpus', none)).toThrow('resources.runtime.cpus: this host cannot cap a VM at 0.5 vCPUs')
  expect(() => assertCpuShare(0.5, 'cpus', cgroup)).not.toThrow()
})

test('caps QEMU and everything below it, and checks they arrived', async () => {
  const io = fakeIo({ tree: [42, 43] })
  const cap = await capVmCpu({ mode: 'cgroup', base: '/cg' }, 42, 0.5, io)
  expect(cap.dir).toBe('/cg/vm-42')
  expect(io.read('/cg/vm-42/cpu.max')).toBe('50000 100000')
  expect(io.read('/cg/vm-42/cgroup.procs')).toBe('42\n43')
  await cap.release()
  expect(io.dirs).not.toContain('/cg/vm-42')
})

test('a VM it cannot move in full fails instead of running uncapped', async () => {
  const io = fakeIo({ tree: [42, 43], failWrite: (_path, value) => (value === '43' ? 'ESRCH: no such process' : undefined) })
  await expect(capVmCpu({ mode: 'cgroup', base: '/cg' }, 42, 0.5, io)).rejects.toThrow('1 of its processes stayed outside its cgroup (43)')
  expect(io.dirs).not.toContain('/cg/vm-42')
})

test('this host says what it can do', () => {
  const quota = cpuQuota()
  if (quota.mode === 'cgroup') expect(quota.base).toMatch(/^\/.*cgroup/)
  else expect(quota.reason.length).toBeGreaterThan(0)
})

test.runIf(cpuQuota().mode === 'none')('a VM never starts at a share this host cannot hold', async () => {
  await expect(createGondolinSandbox({ image: '/nonexistent', cpus: 0.5 })).rejects.toThrow(
    'cpus: this host cannot cap a VM at 0.5 vCPUs',
  )
})

test('switches the cpu controller on below a mount that has not enabled it', () => {
  let enabled = false
  const io = fakeIo({
    files: { '/sys/fs/cgroup/cgroup.controllers': 'cpu' },
    failWrite: (path, value) => {
      if (path.endsWith('cgroup.subtree_control') && value === '+cpu') enabled = true
      return path.endsWith('cpu.max') && !enabled ? 'ENOENT: no such file or directory' : undefined
    },
  })
  expect(detectCpuQuota([['/sys/fs/cgroup', false]], io)).toEqual({ mode: 'cgroup', base: '/sys/fs/cgroup' })
  expect(io.writes).toContainEqual(['/sys/fs/cgroup/cgroup.subtree_control', '+cpu'])
})
