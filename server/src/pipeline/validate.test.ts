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
