import { readFileSync } from 'node:fs'
import { Ajv } from 'ajv'
import { expect, test } from 'vitest'

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const validate = new Ajv().compile(read('../hobwork.schema.json'))
const example = read('./fixtures/hobwork.json')

test('accepts the architecture.md example', () => {
  expect(validate(example), JSON.stringify(validate.errors)).toBe(true)
})

test('accepts an empty config', () => {
  expect(validate({})).toBe(true)
})

test.each([
  ['unknown top-level key', { ...example, cron: {} }],
  ['cron without schedule', { crons: { a: { handler: 'src/a.ts' } } }],
  ['malformed cron schedule', { crons: { a: { schedule: 'daily', handler: 'src/a.ts' } } }],
  ['webhook without handler', { webhooks: { a: {} } }],
  ['route key without method', { routes: { '/spools': { handler: 'src/a.ts' } } }],
  ['trigger without homeassistant', { triggers: { a: { handler: 'src/a.ts' } } }],
  ['egress not an array', { egress: 'api.example.com' }],
  ['bad idleTimeout', { idleTimeout: 'soon' }],
])('rejects %s', (_, config) => {
  expect(validate(config)).toBe(false)
})
