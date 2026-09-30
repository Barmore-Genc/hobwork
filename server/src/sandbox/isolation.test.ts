import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { machine, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createGondolinSandbox } from './gondolin.ts'
import { imageDir } from './image.ts'
import type { Sandbox } from './sandbox.ts'
import { createVmDir, findQemu, isolationAvailableForTests, isolationMode, qemuBwrapArgs, runtimeRoot, workerBwrapArgs } from './isolation.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hobwork-isolation-test-'))
  dirs.push(dir)
  return dir
}

test('isolation is off unless set to namespaces, which needs Linux', () => {
  expect(isolationMode({}, 'linux')).toBe('off')
  expect(isolationMode({ HOBWORK_SANDBOX_ISOLATION: '' }, 'linux')).toBe('off')
  expect(isolationMode({ HOBWORK_SANDBOX_ISOLATION: 'off' }, 'darwin')).toBe('off')
  expect(isolationMode({ HOBWORK_SANDBOX_ISOLATION: 'namespaces' }, 'linux')).toBe('namespaces')
  expect(() => isolationMode({ HOBWORK_SANDBOX_ISOLATION: 'namespaces' }, 'darwin')).toThrow('needs Linux')
  expect(() => isolationMode({ HOBWORK_SANDBOX_ISOLATION: 'on' }, 'linux')).toThrow('must be "namespaces" or "off"')
})

test('VM directories are private and removed with their contents', () => {
  const root = runtimeRoot({ RUNTIME_DIRECTORY: join(tempDir(), 'run') })
  expect(statSync(root).mode & 0o777).toBe(0o700)
  const dir = createVmDir(root)
  expect(statSync(join(root, 'vm')).mode & 0o777).toBe(0o700)
  expect(existsSync(dir.vm) && existsSync(dir.fs)).toBe(true)
  writeFileSync(join(dir.vm, 'disk.qcow2'), '')
  dir.remove()
  expect(existsSync(dir.path)).toBe(false)
})

test('QEMU gets a clean environment and only the image and its own directory', () => {
  const image = tempDir()
  const args = qemuBwrapArgs({ dir: '/run/hobwork/vm/v1', image, kvm: true, qemu: '/usr/bin/qemu-system-x86_64' })
  expect(args).toEqual(expect.arrayContaining(['--unshare-all', '--die-with-parent', '--new-session', '--clearenv']))
  const binds = args.flatMap((arg, i) => (arg === '--bind' || arg === '--dev-bind' ? [args[i + 2]] : []))
  expect(binds).toEqual(['/dev/kvm', '/run/hobwork/vm/v1'])
  expect(args.filter((arg) => arg === '--setenv' || arg === 'PATH')).toEqual(['--setenv', 'PATH'])
  expect(qemuBwrapArgs({ dir: '/run/hobwork/vm/v1', image, kvm: false, qemu: undefined })).not.toContain('/dev/kvm')
})

test('QEMU installed outside the system directories gets its prefix and bin directory', () => {
  const image = tempDir()
  const setup = (qemu: string) => qemuBwrapArgs({ dir: '/run/hobwork/vm/v1', image, qemu }).join(' ')
  expect(setup('/opt/qemu/bin/qemu-system-x86_64')).toContain('--ro-bind /opt/qemu /opt/qemu --setenv PATH /opt/qemu/bin:/usr/local/bin:/usr/bin:/bin')
  expect(setup('/nix/store/abc-qemu-10.1.0/bin/qemu-system-x86_64')).toContain('--ro-bind /nix/store /nix/store --setenv PATH /nix/store/abc-qemu-10.1.0/bin:/usr/local/bin:/usr/bin:/bin')
})

test('QEMU is found on PATH by its real path', () => {
  const opt = tempDir()
  const links = tempDir()
  const binary = join(opt, `qemu-system-${machine()}`)
  writeFileSync(binary, '')
  chmodSync(binary, 0o755)
  symlinkSync(binary, join(links, `qemu-system-${machine()}`))
  expect(findQemu(`/nonexistent:${links}`)).toBe(realpathSync(binary))
  expect(findQemu('/nonexistent')).toBeUndefined()
})

test('the VFS worker gets a clean environment and only its socket and mounts writable', () => {
  const files = tempDir()
  const config = tempDir()
  const args = workerBwrapArgs({ fs: '/run/hobwork/vm/v1/fs', mounts: [{ hostPath: config, readonly: true }, { hostPath: files }], node: '/usr/bin/node' })
  expect(args).toEqual(expect.arrayContaining(['--unshare-all', '--die-with-parent', '--new-session', '--clearenv']))
  const writable = args.flatMap((arg, i) => (arg === '--bind' || arg === '--dev-bind' ? [args[i + 2]] : []))
  expect(writable).toEqual(['/run/hobwork/vm/v1/fs', realpathSync(files), ...(realpathSync(files) === files ? [] : [files])])
  expect(args.join(' ')).toContain(`--ro-bind ${realpathSync(config)} ${realpathSync(config)}`)
})

// Needs Linux with bwrap and unprivileged user namespaces, e.g. in the
// container of dev/sandbox-isolation.
describe.runIf(isolationAvailableForTests())('QEMU namespace', () => {
  function inQemuNamespace(dir: string, image: string, script: string) {
    return spawnSync('bwrap', [...qemuBwrapArgs({ dir, image }), '--', 'sh', '-c', script], {
      encoding: 'utf8',
      env: { ...process.env, HOBWORK_SECRET_KEY: 'a'.repeat(64) },
    })
  }

  test('cannot see the data dir, the host\'s processes or its environment', () => {
    const data = tempDir()
    writeFileSync(join(data, 'secret.key'), 'secret')
    const image = tempDir()
    writeFileSync(join(image, 'rootfs.ext4'), 'rootfs\n')
    const dir = createVmDir(runtimeRoot({ RUNTIME_DIRECTORY: join(tempDir(), 'run') }))

    const result = inQemuNamespace(dir.path, image, `
      cat "$1/rootfs.ext4"
      echo disk > "$2/vm/disk.qcow2"
      cat "$3/secret.key" 2>/dev/null && echo 'read the data dir'
      ls "$3" 2>/dev/null && echo 'listed the data dir'
      echo "processes: $(ls -d /proc/[0-9]* | wc -l)"
      env | grep -q HOBWORK && echo 'got the host environment'
      true
    `.replace('$1', image).replace('$2', dir.path).replaceAll('$3', data))
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toEqual(['rootfs', expect.stringMatching(/^processes: \d$/)])
    expect(readFileSync(join(dir.vm, 'disk.qcow2'), 'utf8')).toBe('disk\n')
    dir.remove()
  })
})

function descendants(pid: number): number[] {
  const children = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === pid ? [Number(name)] : []
    } catch {
      return []
    }
  })
  return children.flatMap((child) => [child, ...descendants(child)])
}

function namespaceView(pid: number) {
  return {
    root: `/proc/${pid}/root`,
    env: readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((e) => e.split('=')[0]).sort(),
    ownNamespaces: ['user', 'mnt', 'pid', 'net'].every((ns) => readlinkSync(`/proc/${pid}/ns/${ns}`) !== readlinkSync(`/proc/self/ns/${ns}`)),
  }
}

function vfsWorker(): number | undefined {
  return descendants(process.pid).find((pid) => {
    const [command, script] = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    return !command?.endsWith('bwrap') && script?.endsWith('/vfs-worker.ts') === true
  })
}

// Swaps `f` between a regular file and a symlink to OUTSIDE while reading it.
// The in-process VFS checks the path with realpath and then opens it, so a
// swap in between would read the file outside the mount.
const SYMLINK_RACE = `
cd /workspace
echo inside > real
end=$(( $(date +%s) + 10 ))
( while [ "$(date +%s)" -lt "$end" ]; do ln -sfn "$1" l.tmp && mv -f l.tmp f; cp real r.tmp && mv -f r.tmp f; done ) &
reads=0 inside=0 leaked=0
while [ "$(date +%s)" -lt "$end" ]; do
  case "$(cat f 2>/dev/null)" in
    *SECRET*) leaked=$((leaked + 1)) ;;
    inside) inside=$((inside + 1)) ;;
  esac
  reads=$((reads + 1))
done
wait
echo "$reads $inside $leaked"
`

// Boots real VMs, so it only runs with HOBWORK_VM_TESTS=1 and isolation on.
describe.runIf(process.env.HOBWORK_VM_TESTS === '1' && process.env.HOBWORK_SANDBOX_ISOLATION === 'namespaces')('isolated VM', { timeout: 120_000 }, () => {
  const data = tempDir()
  const work = tempDir()
  const files = join(work, 'files')
  const config = join(work, 'config')
  const outside = join(work, 'outside.txt')
  let sandbox: Sandbox

  beforeAll(async () => {
    writeFileSync(join(data, 'secret.key'), 'SECRET key')
    writeFileSync(outside, 'SECRET outside the mount')
    mkdirSync(files)
    mkdirSync(config)
    sandbox = await createGondolinSandbox({
      image: imageDir(),
      memory: '512M',
      mounts: { '/workspace': { hostPath: files }, '/config': { hostPath: config, readonly: true } },
    })
  }, 120_000)

  afterAll(async () => {
    await sandbox?.stop()
  })

  test('QEMU runs in its own namespaces and cannot see the data dir or the mounts', () => {
    const qemu = descendants(sandbox.hostPid()!).find((pid) => readFileSync(`/proc/${pid}/comm`, 'utf8').startsWith('qemu-system'))
    expect(qemu).toBeDefined()
    const view = namespaceView(qemu!)
    expect(view.ownNamespaces).toBe(true)
    expect(view.env).toEqual(['PATH', 'PWD'])
    expect(existsSync(join(view.root, data))).toBe(false)
    expect(existsSync(join(view.root, files))).toBe(false)
    expect(existsSync(join(view.root, process.cwd(), 'package.json'))).toBe(false)
    expect(existsSync(join(view.root, imageDir(), 'manifest.json'))).toBe(true)
  })

  test('the VFS worker sees only this VM\'s mounts', () => {
    const worker = vfsWorker()
    expect(worker).toBeDefined()
    const view = namespaceView(worker!)
    expect(view.ownNamespaces).toBe(true)
    expect(view.env).toEqual(['HOME', 'PATH', 'PWD'])
    expect(existsSync(join(view.root, files))).toBe(true)
    expect(existsSync(join(view.root, config))).toBe(true)
    expect(existsSync(join(view.root, data))).toBe(false)
    expect(existsSync(join(view.root, outside))).toBe(false)
    expect(existsSync(join(view.root, process.cwd(), 'src/index.ts'))).toBe(false)
  })

  test('mounts work through the worker, and the host reads and writes them through the guest', async () => {
    writeFileSync(join(config, 'settings.json'), '{"a":1}')
    const result = await sandbox.exec('cat /config/settings.json; echo guest > /workspace/g.txt; echo x > /config/x 2>/dev/null || echo readonly').result
    expect(result.stdout).toBe('{"a":1}readonly\n')
    expect(readFileSync(join(files, 'g.txt'), 'utf8')).toBe('guest\n')
    await sandbox.writeFile('/workspace/h.txt', 'host')
    expect(readFileSync(join(files, 'h.txt'), 'utf8')).toBe('host')
    expect((await sandbox.readFile('/workspace/g.txt')).toString()).toBe('guest\n')
  })

  test('a symlink swapped in while reading never reaches a file outside the mount', async () => {
    const result = await sandbox.exec(`sh -c '${SYMLINK_RACE}' race ${outside}`, { timeoutMs: 60_000 }).result
    expect(result.stderr).toBe('')
    const [reads, inside, leaked] = result.stdout.trim().split(' ').map(Number)
    expect(leaked).toBe(0)
    expect(inside).toBeGreaterThan(0)
    expect(reads).toBeGreaterThan(inside!)
  })

  test('the VM stops when its VFS worker dies', async () => {
    process.kill(vfsWorker()!, 'SIGKILL')
    await sandbox.exited
  })
})
