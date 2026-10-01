import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { qemuPath } from './qemu.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-qemu-'))
  dirs.push(dir)
  return dir
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const machine = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim()
const watchedMachine = machine === 'arm64' ? 'aarch64' : machine

// Prints its arguments one per line, then what it gets on fd 3.
function fakeCommand(dir: string, name: string, readsFd3 = false) {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n${readsFd3 ? 'tr "\\0" "\\n" <&3\n' : ''}`)
  chmodSync(path, 0o755)
}

test('runs QEMU through the watcher unless isolation is on', () => {
  expect(qemuPath({}, 'linux')).toMatch(/qemu-watched\.sh$/)
  expect(qemuPath({ HOBWORK_QEMU_SANDBOX: '1' }, 'linux')).toMatch(/qemu-watched\.sh$/)
  expect(qemuPath({ HOBWORK_SANDBOX_ISOLATION: 'off' }, 'linux')).toMatch(/qemu-watched\.sh$/)
  expect(qemuPath({}, 'darwin')).toMatch(/qemu-watched\.sh$/)
  expect(qemuPath({ HOBWORK_SANDBOX_ISOLATION: 'namespaces' }, 'linux')).toMatch(/qemu-namespaced\.sh$/)
  expect(qemuPath({ HOBWORK_SANDBOX_ISOLATION: 'namespaces', HOBWORK_QEMU_SANDBOX: '1' }, 'linux')).toMatch(/qemu-namespaced\.sh$/)
})

test('refuses the sandbox and isolation off Linux', () => {
  expect(() => qemuPath({ HOBWORK_QEMU_SANDBOX: '1' }, 'darwin')).toThrow('needs Linux')
  expect(() => qemuPath({ HOBWORK_SANDBOX_ISOLATION: 'namespaces' }, 'darwin')).toThrow('needs Linux')
})

test('the watcher starts plain QEMU with Gondolin\'s arguments', () => {
  const dir = tempDir()
  fakeCommand(dir, `qemu-system-${watchedMachine}`)
  const out = execFileSync(qemuPath({}, 'linux'), ['-m', '1G', '-append', 'a b'], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}` },
  })
  expect(out.split('\n').slice(0, -1)).toEqual(['-m', '1G', '-append', 'a b'])
})

test('the watcher kills QEMU when the host dies', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, `qemu-system-${watchedMachine}`), '#!/bin/sh\nexec sleep 60\n')
  chmodSync(join(dir, `qemu-system-${watchedMachine}`), 0o755)
  const host = spawn('sh', ['-c', `"$0" & echo $!; wait`, qemuPath({}, 'linux')], {
    env: { PATH: `${dir}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const [line] = await once(host.stdout, 'data') as [Buffer]
  const qemu = Number(line.toString().trim())
  expect(alive(qemu)).toBe(true)
  host.kill('SIGKILL')
  await expect.poll(() => alive(qemu), { timeout: 5000, interval: 100 }).toBe(false)
})

test('the watcher adds the seccomp filter and keeps Gondolin\'s arguments', () => {
  const dir = tempDir()
  fakeCommand(dir, `qemu-system-${machine}`)
  const out = execFileSync(qemuPath({ HOBWORK_QEMU_SANDBOX: '1' }, 'linux'), ['-m', '1G', '-append', 'a b'], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, HOBWORK_QEMU_SANDBOX: '1' },
  })
  expect(out.split('\n').slice(0, -1)).toEqual([
    '-sandbox',
    'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny',
    '-m',
    '1G',
    '-append',
    'a b',
  ])
})

test('the namespace wrapper starts QEMU through bwrap with the VM\'s options and the worker\'s fs socket', () => {
  const path = qemuPath({ HOBWORK_SANDBOX_ISOLATION: 'namespaces' }, 'linux')
  const bin = tempDir()
  fakeCommand(bin, 'bwrap', true)
  const vm = join(tempDir(), 'v1')
  mkdirSync(join(vm, 'vm'), { recursive: true })
  writeFileSync(join(vm, 'qemu.bwrap'), '--unshare-all\0--bind\0/x y\0/x y\0')
  const control = ['-chardev', `socket,id=virtiocon0,path=${vm}/vm/control.sock,server=off`]
  const args = ['-m', '1G', '-chardev', `socket,id=virtiofs0,path=${vm}.fs.sock,server=off`, ...control]
  const run = (env: NodeJS.ProcessEnv) =>
    execFileSync(path, args, { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, ...env } }).split('\n').slice(0, -1)
  expect(run({})).toEqual([
    '--args', '3', '--', `qemu-system-${machine}`,
    '-m', '1G', '-chardev', `socket,id=virtiofs0,path=${vm}/fs/fs.sock,server=off`, ...control,
    '--unshare-all', '--bind', '/x y', '/x y',
  ])
  expect(run({ HOBWORK_QEMU_SANDBOX: '1' })[3]).toMatch(/\/qemu-sandboxed\.sh$/)
})

test('the namespace wrapper refuses a command line without the control socket', () => {
  const path = qemuPath({ HOBWORK_SANDBOX_ISOLATION: 'namespaces' }, 'linux')
  const bin = tempDir()
  fakeCommand(bin, 'bwrap')
  fakeCommand(bin, `qemu-system-${machine}`)
  const env = { PATH: `${bin}:${process.env.PATH}` }
  expect(execFileSync(path, ['--version'], { encoding: 'utf8', env })).toBe('--version\n')
  expect(() => execFileSync(path, ['-m', '1G'], { encoding: 'utf8', env, stdio: 'pipe' })).toThrow('no control socket')
})
