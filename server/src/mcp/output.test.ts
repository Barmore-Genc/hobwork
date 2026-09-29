import { expect, test } from 'vitest'
import { HeadTailOutput, MAX_OUTPUT_CHARS, truncateMiddle } from './output.ts'

test('keeps short output whole', () => {
  const out = new HeadTailOutput()
  out.push('hello ')
  out.push('world')
  expect(out.toString()).toBe('hello world')
})

test('keeps the head and the tail of long output and counts what it cut', () => {
  const out = new HeadTailOutput(10)
  out.push('0123456789')
  for (let i = 0; i < 1000; i++) out.push('abcde')
  out.push('END-MARKER!')
  const text = out.toString()
  expect(text.startsWith('0123456789\n[... ')).toBe(true)
  expect(text.endsWith('\nND-MARKER!')).toBe(true)
  const omitted = Number(/\[\.\.\. (\d+) characters omitted/.exec(text)?.[1])
  expect(omitted).toBe(10 + 5 * 1000 + 11 - 20)
})

test('a huge stream stays under the output limit, so truncateMiddle leaves it alone', () => {
  const out = new HeadTailOutput()
  for (let i = 0; i < 2000; i++) out.push('x'.repeat(10_000))
  const text = out.toString()
  expect(text).toContain('characters omitted')
  expect(text.length).toBeLessThan(MAX_OUTPUT_CHARS)
  expect(truncateMiddle(text)).toBe(text)
})
