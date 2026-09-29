import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { qemuPath } from './qemu.ts'

test('uses Gondolin\'s QEMU unless the sandbox is on', () => {
  expect(qemuPath({}, 'linux')).toBeUndefined()
  expect(qemuPath({ HOBWORK_QEMU_SANDBOX: '0' }, 'linux')).toBeUndefined()
  expect(qemuPath({}, 'darwin')).toBeUndefined()
})

test('refuses the sandbox off Linux', () => {
  expect(() => qemuPath({ HOBWORK_QEMU_SANDBOX: '1' }, 'darwin')).toThrow('needs Linux')
})

test('the wrapper adds the seccomp filter and keeps Gondolin\'s arguments', () => {
  const path = qemuPath({ HOBWORK_QEMU_SANDBOX: '1' }, 'linux')!
  const dir = mkdtempSync(join(tmpdir(), 'fake-qemu-'))
  try {
    const machine = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim()
    const fake = join(dir, `qemu-system-${machine}`)
    writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n')
    chmodSync(fake, 0o755)
    const out = execFileSync(path, ['-m', '1G', '-append', 'a b'], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}` },
    })
    expect(out.split('\n').slice(0, -1)).toEqual([
      '-sandbox',
      'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny',
      '-m',
      '1G',
      '-append',
      'a b',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
