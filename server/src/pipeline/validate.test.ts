import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { checkViteConfig, validateHobworkJson, VITE_CONFIG } from './validate.ts'

const OLD_VITE_CONFIG = "const config = JSON.parse(readFileSync('hobwork.json', 'utf8')) as HobworkJson\n"
const JSONC = '{\n  // Greets.\n  "routes": { "GET /greeting": { "handler": "src/greeting-route.ts" }, },\n}\n'

test('accepts comments and trailing commas', () => {
  expect(validateHobworkJson(JSONC)).toEqual([])
})

test('validates the parsed value against the schema', () => {
  expect(validateHobworkJson('{\n  // Nightly.\n  "crons": { "a": { "handler": "src/a.ts" } },\n}')).toEqual([
    "/crons/a: must have required property 'schedule'",
  ])
})

test('checks that cron time zones exist', () => {
  expect(validateHobworkJson('{ "crons": { "a": { "schedule": "0 8 * * *", "timeZone": "Europe/Istanbul", "handler": "src/a.ts" } } }')).toEqual([])
  expect(validateHobworkJson('{ "crons": { "a": { "schedule": "0 8 * * *", "timeZone": "person", "handler": "src/a.ts" } } }')).toEqual([])
  expect(validateHobworkJson('{ "crons": { "a": { "schedule": "0 8 * * *", "timeZone": "Mars/Olympus", "handler": "src/a.ts" } } }')).toEqual([
    '/crons/a/timeZone: "Mars/Olympus" is not a known time zone, such as "Europe/Istanbul"',
  ])
})

test('validates resources', () => {
  expect(validateHobworkJson('{ "resources": { "runtime": { "memoryMb": 256, "cpus": 1 }, "workspace": {} } }')).toEqual([])
  expect(validateHobworkJson('{ "resources": { "runtime": { "memoryMb": 12 } } }')).toEqual([
    '/resources/runtime/memoryMb: must be >= 128',
  ])
  expect(validateHobworkJson('{ "resources": { "build": {} } }')).toEqual([
    '/resources: must NOT have additional properties ("build")',
  ])
})

test('reports where hobwork.json cannot be parsed', () => {
  expect(validateHobworkJson('{\n  "egress": ["a.example.com" "b.example.com"]\n}')).toEqual([
    'hobwork.json cannot be parsed: Comma expected at line 2 column 30',
  ])
})

test('asks old projects to switch vite.config.ts when hobwork.json has comments', () => {
  expect(checkViteConfig(JSONC, OLD_VITE_CONFIG)).toContain(VITE_CONFIG)
  expect(checkViteConfig('{ "routes": {} }', OLD_VITE_CONFIG)).toBeUndefined()
  expect(checkViteConfig(JSONC, VITE_CONFIG)).toBeUndefined()
  expect(checkViteConfig(JSONC, undefined)).toBeUndefined()
})

test('the replacement is the template vite.config.ts', () => {
  expect(readFileSync(resolve(import.meta.dirname, '../../../templates/project/vite.config.ts'), 'utf8')).toBe(VITE_CONFIG)
})

test('names the event a device trigger capability takes', () => {
  const config = { triggers: { t: { device: { capability: 'focus', event: 'action' }, handler: 'src/t.ts' } } }
  expect(validateHobworkJson(JSON.stringify(config))).toEqual(['/triggers/t/device/event: must be equal to constant ("changed")'])
})

test('the widget and intents must name routes hobwork.json declares', () => {
  const routes = { 'GET /widget': { handler: 'src/w.ts' }, 'POST /dryer/:id/start': { handler: 'src/d.ts' } }
  const ok = {
    routes,
    widget: { route: '/widget' },
    intents: [
      { id: 'start-dryer', title: 'Start the dryer timer', route: '/dryer/1/start', parameters: [{ id: 'hours', title: 'Hours', type: 'number' }] },
      { id: 'scan', title: 'Open Scan', open: '/scan' },
    ],
  }
  expect(validateHobworkJson(JSON.stringify(ok))).toEqual([])
  const bad = {
    routes,
    widget: { route: '/now' },
    intents: [
      { id: 'a', title: 'A', route: '/dryer/1/start', method: 'GET' },
      { id: 'a', title: 'B', open: '/b' },
    ],
  }
  expect(validateHobworkJson(JSON.stringify(bad))).toEqual([
    '/widget/route: no "GET" route in routes matches /now',
    '/intents/0/route: no "GET" route in routes matches /dryer/1/start',
    '/intents/1/id: "a" is used twice',
  ])
})

test('an intent needs a route or open', () => {
  expect(validateHobworkJson(JSON.stringify({ intents: [{ id: 'a', title: 'A' }] }))).not.toEqual([])
})
