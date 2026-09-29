import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { BackupConfig } from './config.ts'
import { createFakeKopia, type FakeKopia } from './fake-kopia.ts'
import { createKopia, KopiaError, parseBlobTotal } from './kopia.ts'

let dir: string
let fake: FakeKopia
let config: BackupConfig

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hobwork-kopia-'))
  fake = createFakeKopia(join(dir, 'fake'))
  config = {
    kopiaBin: fake.bin,
    endpoint: 'localhost:19000',
    disableTls: true,
    bucket: 'backups',
    prefix: 'hobwork/',
    region: 'eu-central-1',
    accessKeyId: 'AKIA-TEST-ID',
    secretAccessKey: 'secret-access-key',
    password: 'repository-password',
    schedule: '30 3 * * *',
    retention: { daily: 14, weekly: 8, monthly: 12 },
  }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('creates the repository on first use and connects with credentials from the environment', async () => {
  const kopiaDir = join(dir, 'kopia')
  const kopia = createKopia(config, kopiaDir)
  await kopia.ensureRepository()
  const calls = fake.calls()
  expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
    ['repository', 'connect'],
    ['repository', 'create'],
  ])
  expect(calls[1]!.args.slice(2)).toEqual([
    's3',
    '--bucket',
    'backups',
    '--endpoint',
    'localhost:19000',
    '--prefix',
    'hobwork/',
    '--region',
    'eu-central-1',
    '--disable-tls',
    '--no-persist-credentials',
    '--override-hostname',
    'hobwork',
    '--override-username',
    'hobwork',
  ])
  for (const call of calls) {
    expect(call.env).toMatchObject({
      KOPIA_PASSWORD: 'repository-password',
      AWS_ACCESS_KEY_ID: 'AKIA-TEST-ID',
      AWS_SECRET_ACCESS_KEY: 'secret-access-key',
      KOPIA_CONFIG_PATH: join(kopiaDir, 'repository.config'),
      KOPIA_CACHE_DIRECTORY: join(kopiaDir, 'cache'),
      KOPIA_LOG_DIR: join(kopiaDir, 'logs'),
      KOPIA_CHECK_FOR_UPDATES: 'false',
    })
    expect(call.args.join(' ')).not.toMatch(/repository-password|secret-access-key|AKIA-TEST-ID/)
  }

  await kopia.ensureRepository()
  expect(fake.calls()).toHaveLength(2)

  // Another bucket prefix is another repository.
  const moved = createKopia({ ...config, prefix: 'other/' }, kopiaDir)
  await moved.ensureRepository()
  expect(fake.calls().slice(2).map((c) => c.args.slice(0, 2))).toEqual([['repository', 'connect']])
})

test('connects without creating when asked to', async () => {
  const kopia = createKopia(config, join(dir, 'kopia'))
  await expect(kopia.ensureRepository({ create: false })).rejects.toThrow('repository not initialized')
  expect(fake.calls()).toHaveLength(1)
})

test('sets retention once per change', async () => {
  const kopiaDir = join(dir, 'kopia')
  await createKopia(config, kopiaDir).applyRetention()
  await createKopia(config, kopiaDir).applyRetention()
  await createKopia({ ...config, retention: { daily: 7, weekly: 8, monthly: 12 } }, kopiaDir).applyRetention()
  const calls = fake.calls()
  expect(calls).toHaveLength(2)
  expect(calls[0]!.args).toEqual([
    'policy',
    'set',
    '--global',
    '--keep-daily',
    '14',
    '--keep-weekly',
    '8',
    '--keep-monthly',
    '12',
    '--keep-hourly',
    '0',
    '--compression',
    'zstd-fastest',
  ])
  expect(calls[1]!.args[4]).toBe('7')
})

test('snapshot, list, verify and restore parse Kopia output', async () => {
  const kopia = createKopia(config, join(dir, 'kopia'))
  const staging = join(dir, 'staging')
  mkdirSync(staging)
  expect(await kopia.snapshot(staging)).toEqual({ id: 'snap2', totalBytes: 1234, files: 5, uploadedBytes: 1_500_000 })
  expect((await kopia.list()).map((s) => [s.id, s.retention])).toEqual([
    ['snap1', ['latest-2']],
    ['snap2', ['latest-1', 'daily-1']],
  ])
  expect(await kopia.verify(10)).toBe('Processed 5 objects.')
  await kopia.restore('snap1', join(dir, 'restored'))
  expect(fake.calls().map((c) => c.args)).toEqual([
    ['blob', 'stats', '--raw'],
    ['snapshot', 'create', staging, '--json'],
    ['blob', 'stats', '--raw'],
    ['snapshot', 'list', '--all', '--json'],
    ['snapshot', 'verify', '--verify-files-percent=10'],
    ['snapshot', 'restore', 'snap1', join(dir, 'restored'), '--skip-owners'],
  ])
})

test('errors carry Kopia output without secrets', async () => {
  fake.set({ failSnapshot: true })
  const kopia = createKopia(config, join(dir, 'kopia'))
  const err = await kopia.snapshot(dir).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(KopiaError)
  expect((err as Error).message).toBe('kopia snapshot create failed (exit 1): ERROR upload failed for password [redacted]')
})

test('a missing binary says how to fix it', async () => {
  const kopia = createKopia({ ...config, kopiaBin: join(dir, 'nope') }, join(dir, 'kopia'))
  await expect(kopia.list()).rejects.toThrow(`The kopia binary "${join(dir, 'nope')}" was not found`)
})

test('parses the repository size from blob stats', () => {
  expect(parseBlobTotal('Count: 10\nTotal: 5015834\nAverage: 501583\nHistogram:\n')).toBe(5015834)
  expect(parseBlobTotal('nothing')).toBeUndefined()
})
