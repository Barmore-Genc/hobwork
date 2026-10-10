import { readFileSync } from 'node:fs'
import { Ajv } from 'ajv'
import { expect, test } from 'vitest'

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const validate = new Ajv().compile(read('../hobwork.schema.json'))
const example = read('./fixtures/hobwork.json')

test('accepts the architecture.md example', () => {
  expect(validate(example), JSON.stringify(validate.errors)).toBe(true)
})

test('accepts a device trigger for notification actions', () => {
  const config = { triggers: { snooze: { device: { capability: 'notifications', event: 'action' }, handler: 'src/snooze.ts' } } }
  expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
})

test.each(['🧵', '👨‍👩‍👧', '❤️', 'ui/icon.svg', 'icon.png', 'ui/icons/house.jpeg', 'ui/icon.webp'])('accepts the icon %s', (icon) => {
  expect(validate({ icon }), JSON.stringify(validate.errors)).toBe(true)
})

test('accepts hob names in crossAppRequests', () => {
  expect(validate({ crossAppRequests: ['filament', 'add-spools'] }), JSON.stringify(validate.errors)).toBe(true)
})

test('accepts static mounts', () => {
  const config = { static: { '/photos': { dir: 'photos' }, '/files/shared': { dir: 'uploads/shared', public: true } } }
  expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
})

test('accepts cron time zones', () => {
  const crons = {
    istanbul: { schedule: '0 8 * * *', timeZone: 'Europe/Istanbul', handler: 'src/a.ts' },
    each: { schedule: '0 8 * * *', timeZone: 'person', handler: 'src/a.ts' },
    utc: { schedule: '0 8 * * *', timeZone: 'UTC', handler: 'src/a.ts' },
  }
  expect(validate({ crons }), JSON.stringify(validate.errors)).toBe(true)
})

test('accepts egress hosts with and without ports', () => {
  const egress = ['api.example.com', '*.example.com', 'api.example.com:8443', '100.66.127.125:7912', '[fd00::5]:80', 'fd00::5']
  expect(validate({ egress }), JSON.stringify(validate.errors)).toBe(true)
})

test('accepts uploads and triggers for them', () => {
  const config = {
    uploads: { inbox: { prefix: 'prints/inbox/', maxBytes: 209715200, types: ['image/*', '.3mf', 'application/pdf'] } },
    triggers: { arrived: { upload: 'inbox', handler: 'src/arrived.ts' } },
  }
  expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
})

test('accepts an empty config', () => {
  expect(validate({})).toBe(true)
})

test.each([
  ['unknown top-level key', { ...example, cron: {} }],
  ['cron without schedule', { crons: { a: { handler: 'src/a.ts' } } }],
  ['malformed cron schedule', { crons: { a: { schedule: 'daily', handler: 'src/a.ts' } } }],
  ['cron time zone with spaces', { crons: { a: { schedule: '0 8 * * *', timeZone: 'Europe/New York', handler: 'src/a.ts' } } }],
  ['webhook without handler', { webhooks: { a: {} } }],
  ['route key without method', { routes: { '/spools': { handler: 'src/a.ts' } } }],
  ['trigger without homeassistant or device', { triggers: { a: { handler: 'src/a.ts' } } }],
  [
    'trigger with homeassistant and device',
    { triggers: { a: { homeassistant: {}, device: { capability: 'notifications', event: 'action' }, handler: 'src/a.ts' } } },
  ],
  ['device trigger with an unknown event', { triggers: { a: { device: { capability: 'notifications', event: 'x' }, handler: 'src/a.ts' } } }],
  ['egress not an array', { egress: 'api.example.com' }],
  ['egress with a URL', { egress: ['https://api.example.com'] }],
  ['upload prefix without a trailing slash', { uploads: { inbox: { prefix: 'inbox' } } }],
  ['upload prefix going up', { uploads: { inbox: { prefix: '../inbox/' } } }],
  ['upload over 1 GB', { uploads: { inbox: { prefix: 'inbox/', maxBytes: 2147483648 } } }],
  ['upload type that is neither MIME type nor extension', { uploads: { inbox: { prefix: 'inbox/', types: ['3mf'] } } }],
  ['trigger with an upload and a device', { triggers: { a: { upload: 'inbox', device: { capability: 'nfc', event: 'scanned' }, handler: 'src/a.ts' } } }],
  ['egress with a named port', { egress: ['api.example.com:https'] }],
  ['crossAppRequests with a URL', { crossAppRequests: ['https://filament.apps.example.com'] }],
  ['crossAppRequests with a wildcard', { crossAppRequests: ['*'] }],
  ['crossAppRequests not an array', { crossAppRequests: 'filament' }],
  ['bad idleTimeout', { idleTimeout: 'soon' }],
  ['empty icon', { icon: '' }],
  ['icon with an unsupported image type', { icon: 'ui/icon.gif' }],
  ['absolute icon path', { icon: '/etc/icon.png' }],
  ['icon path outside the repo', { icon: '../icon.png' }],
  ['icon that is a sentence', { icon: 'a house with a garden' }],
  ['static mount under /api', { static: { '/api/photos': { dir: 'photos' } } }],
  ['static mount at /_hobwork', { static: { '/_hobwork': { dir: 'photos' } } }],
  ['static mount under /theme', { static: { '/theme/x': { dir: 'photos' } } }],
  ['static mount at the root', { static: { '/': { dir: 'photos' } } }],
  ['static mount with a trailing slash', { static: { '/photos/': { dir: 'photos' } } }],
  ['static mount without a slash', { static: { photos: { dir: 'photos' } } }],
  ['static mount without dir', { static: { '/photos': {} } }],
  ['static dir outside the files', { static: { '/photos': { dir: '../photos' } } }],
  ['static dir with a dot segment', { static: { '/photos': { dir: 'a/./b' } } }],
  ['static public not a boolean', { static: { '/photos': { dir: 'photos', public: 'yes' } } }],
  ['widget without route', { widget: {} }],
  ['widget route that is not a path', { widget: { route: 'widget' } }],
  ['intent without route or open', { intents: [{ id: 'a', title: 'A' }] }],
  ['intent with a bad id', { intents: [{ id: 'a b', title: 'A', open: '/' }] }],
  ['intent parameter of an unknown type', { intents: [{ id: 'a', title: 'A', open: '/', parameters: [{ id: 'p', title: 'P', type: 'date' }] }] }],
  ['share target without accepts', { share: [{ id: 'a', title: 'A', route: '/share' }] }],
  ['share target that accepts nothing', { share: [{ id: 'a', title: 'A', accepts: {}, route: '/share' }] }],
  ['share target without route', { share: [{ id: 'a', title: 'A', accepts: { urls: true } }] }],
  ['share file type that is neither MIME type nor extension', { share: [{ id: 'a', title: 'A', accepts: { files: ['3mf'] }, upload: 'inbox', route: '/s' }] }],
  ['share upload that is not a name', { share: [{ id: 'a', title: 'A', accepts: { urls: true }, upload: 'In Box', route: '/s' }] }],
  ['appLinks path without a slash', { appLinks: { include: ['spool/*'] } }],
  ['appLinks with a fragment', { appLinks: { exclude: ['/a#b'] } }],
  ['appLinks with another key', { appLinks: { paths: ['/a'] } }],
])('rejects %s', (_, config) => {
  expect(validate(config)).toBe(false)
})

test('accepts share targets and app links', () => {
  const config = {
    uploads: { inbox: { prefix: 'inbox/', maxBytes: 209715200, types: ['model/3mf', '.3mf', 'image/*'] } },
    share: [
      { id: 'queue', title: 'Add to the queue', accepts: { urls: true, files: ['model/3mf', '.3mf', 'image/*'] }, upload: 'inbox', route: '/share' },
      { id: 'note', title: 'Add a note', accepts: { text: true }, route: '/notes' },
    ],
    appLinks: { include: ['/spool/*', '/bin/?'], exclude: ['/print/*'] },
  }
  expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
})

test('accepts a widget and intents', () => {
  const config = {
    widget: { route: '/widget' },
    intents: [
      { id: 'where-is', title: 'Where is a spool', route: '/intents/where', parameters: [{ id: 'spool', title: 'Spool', type: 'number' }] },
      { id: 'scan', title: 'Open Scan', open: '/scan' },
      { id: 'start-dryer', title: 'Start the dryer timer', route: '/dryer/start', method: 'POST', opensApp: true, open: '/dry' },
    ],
  }
  expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
})
