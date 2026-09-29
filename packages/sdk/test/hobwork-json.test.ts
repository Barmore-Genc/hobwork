import { expect, test } from 'vitest'
import { parseHobworkJson } from '../src/hobwork-json.js'

test('parses comments and trailing commas', () => {
  const text = `{
  // Checks the printer every morning.
  "crons": {
    "check": { "schedule": "0 7 * * *", "handler": "src/check.ts", },
  },
  /* Spoolman */
  "egress": ["spoolman.local",],
}
`
  expect(parseHobworkJson(text)).toEqual({
    crons: { check: { schedule: '0 7 * * *', handler: 'src/check.ts' } },
    egress: ['spoolman.local'],
  })
})

test('parses plain JSON like JSON.parse', () => {
  const text = JSON.stringify({ a: [1, -2.5e3, true, null, 'x\n"y"'], b: {} })
  expect(parseHobworkJson(text)).toEqual(JSON.parse(text))
})

test('keeps a "__proto__" key as a property, like JSON.parse', () => {
  const value = parseHobworkJson('{ "routes": { "__proto__": { "handler": "src/a.ts" } } }') as {
    routes: Record<string, unknown>
  }
  expect(Object.getPrototypeOf(value.routes)).toBe(Object.prototype)
  expect(Object.keys(value.routes)).toEqual(['__proto__'])
})

test('reports the line and column of the first error', () => {
  expect(() => parseHobworkJson('{\n  "a": 1\n  "b": 2\n}')).toThrow('Comma expected at line 3 column 3')
  expect(() => parseHobworkJson('{\n  "a": 1,\n  // "b": 2\n  c: 3\n}')).toThrow('Invalid symbol at line 4 column 3')
})

test.each([
  ['empty text', ''],
  ['single quotes', "{ 'a': 1 }"],
  ['unquoted key', '{ a: 1 }'],
  ['two values', '{} {}'],
  ['leading zero', '{ "a": 01 }'],
  ['hex number', '{ "a": 0x1 }'],
  ['NaN', '{ "a": NaN }'],
  ['control character in a string', '{ "a": "x\ty" }'],
  ['a lone comma', '[,]'],
  ['unterminated comment', '{} /* x'],
])('rejects %s', (_, text) => {
  expect(() => parseHobworkJson(text)).toThrow(SyntaxError)
})
