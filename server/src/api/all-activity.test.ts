import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAgentToken } from '../agents.ts'
import { createProject } from '../projects.ts'
import { appendLog, finishInvocation, startInvocation, type InvocationKind } from '../runtime/logs.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp } from '../test-web.ts'

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string

function run(project: string, kind: InvocationKind, name: string, result: 'ok' | 'error', startedAt: string) {
  const id = startInvocation(host, { project, version: 2, kind, name, manual: false })
  host.db.prepare('UPDATE invocations SET started_at = ? WHERE id = ?').run(startedAt, id)
  finishInvocation(host, id, { status: result, durationMs: 12, ...(result === 'error' ? { error: 'Error: no spools' } : {}) })
  return id
}

beforeEach(async () => {
  host = createTestHost()
  app = await startTestApp(host)
  cookie = signedIn(host).cookie
  await createProject(host, 'filament')
  await createProject(host, 'sleep')
  run('filament', 'cron', 'weigh', 'ok', '2026-09-01T07:00:00.000Z')
  run('filament', 'route', 'GET /spools', 'error', '2026-09-01T08:00:00.000Z')
  run('sleep', 'cron', 'alarm', 'ok', '2026-09-01T09:00:00.000Z')
  run('sleep', 'trigger', 'bed', 'error', '2026-09-01T10:00:00.000Z')
  appendLog(host, {
    project: 'sleep',
    source: 'runtime',
    level: 'warn',
    event: 'egress-blocked',
    message: 'Blocked outgoing request to evil.example:443',
    time: '2026-09-01T09:30:00.000Z',
  })
  appendLog(host, {
    project: 'filament',
    source: 'runtime',
    level: 'error',
    event: 'auto-revert',
    message: 'Version 3 is broken',
    time: '2026-09-01T08:30:00.000Z',
  })
  appendLog(host, {
    project: 'filament',
    source: 'runtime',
    level: 'warn',
    event: 'db',
    message: 'Slow query',
    time: '2026-09-01T06:00:00.000Z',
  })
  // Neither a problem: an info event and a plain warning line.
  appendLog(host, { project: 'filament', source: 'runtime', level: 'info', event: 'deploy', message: 'Version 3 is live' })
  appendLog(host, { project: 'filament', source: 'handler', level: 'warn', message: 'low on spools' })
})

afterEach(async () => {
  await app.close()
  host.dispose()
})

async function get(path: string, headers: Record<string, string> = { cookie }) {
  const res = await fetch(`${app.base}${path}`, { headers })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { invocations?: { id: number; project: string; name: string }[] } }
}

test('lists runs of every project, newest first, with filters and paging', async () => {
  const all = await get('/api/activity')
  expect(all.body.invocations!.map((i) => `${i.project} ${i.name}`)).toEqual([
    'sleep bed',
    'sleep alarm',
    'filament GET /spools',
    'filament weigh',
  ])
  expect(all.body.invocations![0]).toMatchObject({ status: 'error', durationMs: 12, error: 'Error: no spools' })
  expect(all.body.invocations![0]).not.toHaveProperty('stack')

  expect((await get('/api/activity?project=filament')).body.invocations!.map((i) => i.name)).toEqual(['GET /spools', 'weigh'])
  expect((await get('/api/activity?status=error')).body.invocations!.map((i) => i.name)).toEqual(['bed', 'GET /spools'])
  expect((await get('/api/activity?kind=cron')).body.invocations!.map((i) => i.name)).toEqual(['alarm', 'weigh'])

  const first = await get('/api/activity?limit=3')
  expect(first.body.more).toBe(true)
  const last = first.body.invocations!.at(-1)!.id
  const next = await get(`/api/activity?limit=3&before=${last}`)
  expect(next.body).toMatchObject({ invocations: [{ name: 'weigh' }], more: false })

  expect((await get('/api/activity?project=nope')).status).toBe(404)
  expect((await get('/api/activity?status=bad')).status).toBe(400)
})

test('problems are failed runs and warning events of every project', async () => {
  const { body } = await get('/api/activity/problems')
  const items = body.items as { type: string; time: string; run?: { name: string }; event?: { event: string; project: string } }[]
  expect(items.map((i) => (i.type === 'run' ? `run ${i.run!.name}` : `${i.event!.event} ${i.event!.project}`))).toEqual([
    'run bed',
    'egress-blocked sleep',
    'auto-revert filament',
    'run GET /spools',
    'db filament',
  ])

  const page = await get('/api/activity/problems?limit=2')
  expect(page.body.more).toBe(true)
  const before = (page.body.items as { time: string }[]).at(-1)!.time
  const rest = await get(`/api/activity/problems?before=${encodeURIComponent(before)}`)
  expect((rest.body.items as unknown[]).length).toBe(3)

  const sleep = await get('/api/activity/problems?project=sleep')
  expect((sleep.body.items as unknown[]).length).toBe(2)

  expect((await get('/api/activity/attention?since=2026-09-01T08:15:00Z')).body).toEqual({ count: 3, more: false })
  expect((await get('/api/activity/attention')).status).toBe(400)
})

test('only signed-in people see activity across projects', async () => {
  const { token } = createAgentToken(host.db, 'claude')
  for (const path of ['/api/activity', '/api/activity/problems', '/api/activity/attention?since=2026-01-01T00:00:00Z']) {
    expect((await get(path, { authorization: `Bearer ${token}` })).status).toBe(401)
    expect((await get(path, {})).status).toBe(401)
  }
})
