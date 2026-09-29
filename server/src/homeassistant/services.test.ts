import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrationsDir, openDb } from '../db.ts'
import { migrate } from '../migrate.ts'
import { createProject, getProject } from '../projects.ts'
import { appendLog, queryLogs } from '../runtime/logs.ts'
import { createTestHost } from '../test-host.ts'
import { seedMain } from '../test-project.ts'
import {
  backfillHaEvents,
  backfillHaServices,
  findEventFires,
  haServicesNote,
  findServiceCalls,
  getHaServices,
  HaServicesError,
  parseServiceEntries,
  setHaServices,
} from './services.ts'

let host: ReturnType<typeof createTestHost>

beforeEach(() => {
  host = createTestHost()
})

afterEach(() => host.dispose())

const id = (name: string) => getProject(host, name)!.id
const logLines = (name: string) => queryLogs(host, { project: name, limit: 50 }).map((entry) => entry.message)

test('entries are domains or services, lowercased, sorted and deduplicated', () => {
  expect(parseServiceEntries([' Light ', 'light', 'tts.speak', 'cover'])).toEqual(['cover', 'light', 'tts.speak'])
  expect(parseServiceEntries([])).toEqual([])
  for (const bad of ['light.turn_on.now', 'light turn_on', '', '*', 'a/b', 5]) {
    expect(() => parseServiceEntries([bad])).toThrow(HaServicesError)
  }
  expect(() => parseServiceEntries('light')).toThrow('The list must have')
})

test('entries that change Home Assistant itself are refused', () => {
  for (const entry of ['hassio', 'hassio.host_reboot', 'homeassistant', 'homeassistant.restart', 'shell_command', 'recorder.purge']) {
    expect(() => parseServiceEntries([entry]), entry).toThrow('changes Home Assistant itself')
  }
  expect(parseServiceEntries(['recorder', 'recorder.enable'])).toEqual(['recorder', 'recorder.enable'])
})

test('saving replaces the list and writes who changed what to the hob log', async () => {
  await createProject(host, 'lights')
  expect(getHaServices(host.db, id('lights'))).toEqual([])
  setHaServices(host, 'lights', ['light', 'tts.speak'], { kind: 'user', name: 'Kaan' })
  setHaServices(host, 'lights', ['light', 'switch'], { kind: 'agent', name: 'claude' })
  setHaServices(host, 'lights', ['light', 'switch'], { kind: 'agent', name: 'claude' })
  expect(getHaServices(host.db, id('lights'))).toEqual(['light', 'switch'])
  expect(logLines('lights')).toEqual([
    'Kaan changed the Home Assistant services and events this hob may use: allowed light, tts.speak',
    'Agent claude changed the Home Assistant services and events this hob may use: allowed switch; no longer allowed tts.speak',
  ])
})

test('finds the services named in source', () => {
  expect(
    findServiceCalls(`
      await ctx.ha.callService('light', 'turn_on', { brightness: 3 })
      await ctx.ha.callService(
        "media_player",
        "play_media",
      )
      await ha.callService(\`tts\`, \`speak\`)
    `),
  ).toEqual({ services: ['light.turn_on', 'media_player.play_media', 'tts.speak'], dynamic: false })
  expect(findServiceCalls(`ctx.ha.callService(domain, 'turn_on')`)).toEqual({ services: [], dynamic: true })
  expect(findServiceCalls(`ctx.ha.getState('light.a')`)).toEqual({ services: [], dynamic: false })
})

test('existing hobs get the domains their deployed code and log already call', async () => {
  await createProject(host, 'lights')
  await createProject(host, 'quiet')
  await createProject(host, 'wild')
  host.db.prepare('INSERT INTO project_ha_services_backfill (project_id) SELECT id FROM projects').run()
  await seedMain(host, 'lights', {
    'package.json': '{}',
    'hobwork.json': '{}',
    'src/a.ts': `await ctx.ha.callService('light', 'turn_on')\nawait ctx.ha.callService('homeassistant', 'restart')\n`,
    'src/b.tsx': `ctx.ha.callService('switch', 'toggle')`,
    'src/a.test.ts': `ctx.ha.callService('lock', 'unlock')`,
    'node_modules/dep/index.js': `ctx.ha.callService('cover', 'open_cover')`,
    'README.md': `ctx.ha.callService('fan', 'turn_on')`,
  })
  await seedMain(host, 'quiet', { 'package.json': '{}', 'hobwork.json': '{}', 'src/a.ts': `await ctx.ha.getState('light.a')` })
  await seedMain(host, 'wild', { 'package.json': '{}', 'hobwork.json': '{}', 'src/a.ts': `await ctx.ha.callService(domain, service)` })
  appendLog(host, { project: 'quiet', source: 'runtime', level: 'info', message: 'Home Assistant: tts.speak {"message":"hi"}' })
  appendLog(host, { project: 'quiet', source: 'runtime', level: 'debug', message: 'Home Assistant: get state of light.a' })
  appendLog(host, { project: 'quiet', source: 'runtime', level: 'warn', message: 'Home Assistant: denied lock.unlock. no' })
  appendLog(host, { project: 'quiet', source: 'runtime', level: 'info', message: 'Home Assistant: hassio.reboot failed: no' })

  await backfillHaServices(host)

  expect(getHaServices(host.db, id('lights'))).toEqual(['light', 'switch'])
  expect(getHaServices(host.db, id('quiet'))).toEqual(['tts'])
  expect(getHaServices(host.db, id('wild'))).toEqual([])
  expect(logLines('lights')).toEqual([
    "Hobwork now limits the Home Assistant services this hob may call. Its deployed code already calls light, switch, so those domains are allowed. People change this on the hob's Home Assistant page in Hobwork.",
  ])
  expect(logLines('wild')[0]).toContain('name their service in a variable')
  expect(host.db.prepare('SELECT count(*) AS n FROM project_ha_services_backfill').get()).toEqual({ n: 0 })

  setHaServices(host, 'quiet', [], { kind: 'user', name: 'Kaan' })
  await backfillHaServices(host)
  expect(getHaServices(host.db, id('quiet'))).toEqual([])
})

test('hobs created after the migration start with an empty list and are not backfilled', async () => {
  await createProject(host, 'fresh')
  expect(host.db.prepare('SELECT count(*) AS n FROM project_ha_services_backfill').get()).toEqual({ n: 0 })
  await backfillHaServices(host)
  expect(getHaServices(host.db, id('fresh'))).toEqual([])
})

test('the migration queues the hobs that already exist for the backfill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hobwork-ha-migrate-'))
  const db = openDb(':memory:')
  try {
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'))
    for (const name of files.filter((n) => n < '0029')) copyFileSync(join(migrationsDir, name), join(dir, name))
    migrate(db, dir)
    db.prepare("INSERT INTO projects (name) VALUES ('old')").run()
    copyFileSync(join(migrationsDir, '0029_ha_services.sql'), join(dir, '0029_ha_services.sql'))
    migrate(db, dir)
    db.prepare("INSERT INTO projects (name) VALUES ('new')").run()
    expect(db.prepare('SELECT p.name FROM project_ha_services_backfill b JOIN projects p ON p.id = b.project_id').all()).toEqual([
      { name: 'old' },
    ])
    expect(db.prepare('SELECT count(*) AS n FROM project_ha_services').get()).toEqual({ n: 0 })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('event entries keep their case and refuse Home Assistant own events', () => {
  expect(parseServiceEntries(['event:Spool_Empty', 'light'])).toEqual(['event:Spool_Empty', 'light'])
  for (const entry of ['event:', 'event:has space', 'event:state_changed', 'event:homeassistant_start', 'event:HASSIO_x', 'event:zone_registry_updated']) {
    expect(() => parseServiceEntries([entry]), entry).toThrow(HaServicesError)
  }
})

test('the services note lists services and events separately', () => {
  expect(haServicesNote(['event:a', 'light'])).toBe(
    'Handlers may call these Home Assistant services: light. Anything else is refused. They may fire these events: a. Any other fireEvent is refused.',
  )
  expect(haServicesNote([])).toBe('Handlers may not call any Home Assistant service yet. They may not fire any event yet.')
})

test('finds the events named in source', () => {
  expect(findEventFires(`ctx.ha.fireEvent('spool_empty', {})\nha.fireEvent("a.b-c")`)).toEqual({ events: ['spool_empty', 'a.b-c'], dynamic: false })
  expect(findEventFires('ctx.ha.fireEvent(name)')).toEqual({ events: [], dynamic: true })
})

test('existing hobs get the events their deployed code and log already fire', async () => {
  await createProject(host, 'events')
  host.db.prepare('INSERT INTO project_ha_events_backfill (project_id) SELECT id FROM projects').run()
  await seedMain(host, 'events', {
    'package.json': '{}',
    'hobwork.json': '{}',
    'src/a.ts': `await ctx.ha.fireEvent('spool_empty')\nawait ctx.ha.fireEvent('state_changed')`,
    'src/a.test.ts': `ctx.ha.fireEvent('only_test')`,
  })
  appendLog(host, { project: 'events', source: 'runtime', level: 'info', message: 'Home Assistant: fire event from_log {"a":1}' })
  await backfillHaEvents(host)
  expect(getHaServices(host.db, id('events'))).toEqual(['event:from_log', 'event:spool_empty'])
  expect(host.db.prepare('SELECT count(*) AS n FROM project_ha_events_backfill').get()).toEqual({ n: 0 })
})
