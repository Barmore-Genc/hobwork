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
])('rejects %s', (_, config) => {
  expect(validate(config)).toBe(false)
})
