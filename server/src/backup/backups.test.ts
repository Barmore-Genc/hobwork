import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { openHostDb } from '../db.ts'
import type { Host } from '../host.ts'
import { createProject } from '../projects.ts'
import { signedIn, startTestApp, writeHeaders } from '../test-web.ts'
import { BackupBusyError, createBackups, lastSuccessfulRun, listBackupRuns, stagingDir, type BackupRun } from './backups.ts'
import type { BackupConfig } from './config.ts'
import { createFakeKopia, type FakeKopia } from './fake-kopia.ts'

// Each backup starts the fake kopia several times and clones repos with git,
// which is slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 20_000 })

let dataDir: string
let host: Host
let fake: FakeKopia
let config: BackupConfig
let messages: string[]
const logger = { info: (m: string) => messages.push(`info: ${m}`), error: (m: string) => messages.push(`error: ${m}`) }

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hobwork-backups-'))
  host = { db: openHostDb(join(dataDir, 'hobwork.db')), dataDir }
  fake = createFakeKopia(join(dataDir, 'fake'))
  messages = []
  config = {
    kopiaBin: fake.bin,
    endpoint: 'localhost:19000',
    disableTls: true,
    bucket: 'backups',
    prefix: 'hobwork/',
    accessKeyId: 'AKIA-TEST-ID',
    secretAccessKey: 'secret-access-key',
    password: 'repository-password',
    schedule: '30 3 * * *',
    retention: { daily: 14, weekly: 8, monthly: 12 },
  }
})

afterEach(() => {
  vi.useRealTimers()
  host.db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('a backup stages the data dir, snapshots it and records the run', async () => {
  await createProject(host, 'filament')
  const backups = createBackups(host, config, { logger })
  const run = await backups.run('manual')

  expect(run).toMatchObject({
    trigger: 'manual',
    status: 'succeeded',
    snapshotId: 'snap2',
    totalBytes: 1234,
    files: 5,
    uploadedBytes: 1_500_000,
    error: null,
  })
  expect(run.durationMs).toBeGreaterThanOrEqual(0)
  expect(run.finishedAt).not.toBeNull()
  const calls = fake.calls()
  expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
    'repository connect',
    'repository create',
    'policy set',
    'blob stats',
    'snapshot create',
    'blob stats',
  ])
  expect(calls[4]!.args[2]).toBe(stagingDir(dataDir))
  expect(calls[4]!.staged).toEqual(expect.arrayContaining(['hobwork.db', 'repos/filament.git/HEAD']))
  expect(existsSync(stagingDir(dataDir))).toBe(false)
  expect(messages).toEqual(['info: Backup snap2 done: 1 hobs, 1234 bytes, 1500000 bytes uploaded'])

  await backups.run('manual')
  expect(fake.calls().slice(6).map((c) => c.args.slice(0, 2).join(' '))).toEqual(['blob stats', 'snapshot create', 'blob stats'])
  expect(listBackupRuns(host).map((r) => r.id)).toEqual([2, 1])
})

test('a failed backup is recorded and logged', async () => {
  fake.set({ failSnapshot: true })
  const run = await createBackups(host, config, { logger }).run('schedule')
  expect(run).toMatchObject({ trigger: 'schedule', status: 'failed', snapshotId: null })
  expect(run.error).toBe('kopia snapshot create failed (exit 1): ERROR upload failed for password [redacted]')
  expect(messages).toEqual([`error: BACKUP FAILED: ${run.error}`])
  expect(lastSuccessfulRun(host)).toBeUndefined()
  expect(existsSync(stagingDir(dataDir))).toBe(false)
})

test('only one backup runs at a time, also across processes', async () => {
  const backups = createBackups(host, config, { logger })
  const first = backups.begin('manual')
  expect(first.run.status).toBe('running')
  expect(backups.running()).toBe(true)
  expect(() => backups.begin('manual')).toThrow(BackupBusyError)
  const other = createBackups(host, config, { logger })
  expect(() => other.begin('manual')).toThrow('A backup is already running')
  await first.done
  expect(backups.running()).toBe(false)

  // A lock left by a process that died is taken over.
  writeFileSync(join(dataDir, 'backup.lock'), '999999999')
  expect((await other.run('manual')).status).toBe('succeeded')
})

test('runs on the schedule, and fails runs a stopped host left behind', async () => {
  host.db.prepare("INSERT INTO backup_runs (trigger) VALUES ('schedule')").run()
  vi.useFakeTimers({ now: new Date(2026, 8, 28, 3, 29, 0), toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const backups = createBackups(host, config, { logger })
  backups.schedule()
  expect(listBackupRuns(host)[0]).toMatchObject({ status: 'failed', error: 'Interrupted by a host restart' })
  expect(backups.nextRun()).toEqual(new Date(2026, 8, 28, 3, 30))

  await vi.advanceTimersByTimeAsync(60_000)
  expect(backups.nextRun()).toEqual(new Date(2026, 8, 29, 3, 30))
  vi.useRealTimers()
  await vi.waitFor(() => expect(listBackupRuns(host)[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded' }), {
    timeout: 10_000,
  })
  backups.stop()
  expect(backups.nextRun()).toBeUndefined()
})

test('without a schedule only manual backups run', () => {
  const backups = createBackups(host, { ...config, schedule: undefined }, { logger })
  backups.schedule()
  expect(backups.nextRun()).toBeUndefined()
})

test('web API shows the status and starts a backup for signed-in users only', async () => {
  const backups = createBackups(host, config, { logger })
  const app = await startTestApp(host, { backups })
  const off = await startTestApp(host)
  try {
    const { cookie } = signedIn(host)
    expect((await fetch(`${app.base}/api/backups`)).status).toBe(401)

    const started = await fetch(`${app.base}/api/backups`, { method: 'POST', headers: writeHeaders(cookie) })
    expect(started.status).toBe(202)
    expect(await started.json()).toMatchObject({ status: 'running', trigger: 'manual' })
    const busy = await fetch(`${app.base}/api/backups`, { method: 'POST', headers: writeHeaders(cookie) })
    expect(busy.status).toBe(409)

    await vi.waitFor(() => expect(backups.running()).toBe(false), { timeout: 10_000 })
    const status = await (await fetch(`${app.base}/api/backups`, { headers: { cookie } })).json()
    expect(status).toMatchObject({
      configured: true,
      destination: 'backups/hobwork/',
      schedule: '30 3 * * *',
      retention: { daily: 14, weekly: 8, monthly: 12 },
      running: false,
      lastSuccess: { snapshotId: 'snap2' },
    })
    expect((status as { runs: BackupRun[] }).runs).toHaveLength(1)

    expect(await (await fetch(`${off.base}/api/backups`, { headers: { cookie } })).json()).toEqual({ configured: false })
    expect((await fetch(`${off.base}/api/backups`, { method: 'POST', headers: writeHeaders(cookie) })).status).toBe(409)
  } finally {
    await app.close()
    await off.close()
  }
})
