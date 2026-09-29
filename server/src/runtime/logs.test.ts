import { afterEach, beforeEach, expect, test } from 'vitest'
import { createProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import {
  appendLog,
  appendLogs,
  failInterruptedInvocations,
  finishInvocation,
  getInvocation,
  lastLogId,
  listInvocations,
  MAX_MESSAGE_CHARS,
  pruneLogs,
  queryLogs,
  startInvocation,
  waitForLogs,
} from './logs.ts'

let host: ReturnType<typeof createTestHost>

beforeEach(async () => {
  host = createTestHost()
  await createProject(host, 'filament')
  await createProject(host, 'alarms')
})

afterEach(() => host.dispose())

function invocation(name = 'tick') {
  return startInvocation(host, { project: 'filament', version: 2, kind: 'cron', name, manual: false })
}

test('records invocations and lists them newest first with filters', () => {
  const a = invocation('a')
  const b = invocation('b')
  finishInvocation(host, a, { status: 'ok', durationMs: 12.4 })
  finishInvocation(host, b, { status: 'error', durationMs: 3, error: 'Error: x', stack: 'Error: x\n    at y' })
  expect(getInvocation(host, a)).toMatchObject({ project: 'filament', version: 2, status: 'ok', durationMs: 12 })
  expect(listInvocations(host, { project: 'filament', limit: 10 }).map((i) => i.id)).toEqual([b, a])
  expect(listInvocations(host, { project: 'filament', status: 'error', limit: 10 })).toEqual([
    expect.objectContaining({ id: b, error: 'Error: x', stack: 'Error: x\n    at y' }),
  ])
  expect(listInvocations(host, { project: 'filament', beforeId: b, limit: 10 }).map((i) => i.id)).toEqual([a])
  expect(listInvocations(host, { project: 'alarms', limit: 10 })).toEqual([])
})

test('queries logs by invocation, cursor, level and source', () => {
  const id = invocation()
  appendLogs(host, [
    { project: 'filament', invocationId: id, source: 'handler', level: 'debug', message: 'one' },
    { project: 'filament', invocationId: id, source: 'handler', level: 'error', message: 'two' },
    { project: 'filament', source: 'runtime', level: 'info', event: 'start', message: 'started' },
    { project: 'alarms', source: 'runtime', level: 'info', message: 'other project' },
  ])
  const all = queryLogs(host, { project: 'filament', limit: 10 })
  expect(all.map((l) => l.message)).toEqual(['one', 'two', 'started'])
  expect(queryLogs(host, { project: 'filament', invocationId: id, limit: 10 }).map((l) => l.message)).toEqual(['one', 'two'])
  expect(queryLogs(host, { project: 'filament', afterId: all[0]!.id, limit: 1 }).map((l) => l.message)).toEqual(['two'])
  expect(queryLogs(host, { project: 'filament', minLevel: 'info', limit: 10 }).map((l) => l.message)).toEqual(['two', 'started'])
  expect(queryLogs(host, { project: 'filament', source: 'runtime', limit: 10 })[0]).toMatchObject({ event: 'start' })
  // Without a starting point: the latest lines, still oldest first.
  expect(queryLogs(host, { project: 'filament', limit: 2 }).map((l) => l.message)).toEqual(['two', 'started'])
  expect(lastLogId(host, 'filament')).toBe(all[2]!.id)
})

test('cuts long messages', () => {
  appendLog(host, { project: 'filament', source: 'handler', level: 'info', message: 'x'.repeat(MAX_MESSAGE_CHARS * 2) })
  const [line] = queryLogs(host, { project: 'filament', limit: 1 })
  expect(line!.message.length).toBeLessThan(MAX_MESSAGE_CHARS + 100)
  expect(line!.message).toContain('characters omitted')
})

test('wakes waiters when lines arrive', async () => {
  const waiting = waitForLogs('filament', 5000)
  appendLog(host, { project: 'filament', source: 'handler', level: 'info', message: 'hi' })
  await waiting
  const started = Date.now()
  await waitForLogs('filament', 50)
  expect(Date.now() - started).toBeGreaterThanOrEqual(40)
})

test('fails invocations interrupted by a restart and prunes old rows', () => {
  const id = invocation()
  failInterruptedInvocations(host)
  expect(getInvocation(host, id)).toMatchObject({ status: 'error', error: 'Interrupted by a host restart' })
  appendLog(host, { project: 'filament', source: 'handler', level: 'info', message: 'old', time: '2020-01-01T00:00:00.000Z' })
  appendLog(host, { project: 'filament', source: 'handler', level: 'info', message: 'new' })
  host.db.prepare("UPDATE invocations SET started_at = '2020-01-01T00:00:00.000Z'").run()
  pruneLogs(host)
  expect(queryLogs(host, { project: 'filament', limit: 10 }).map((l) => l.message)).toEqual(['new'])
  expect(getInvocation(host, id)).toBeUndefined()
})
