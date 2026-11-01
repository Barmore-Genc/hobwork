import { expect, test } from 'vitest'
import { redact } from './redact.ts'

const SECRETS = { SHOP_PASSWORD: { value: 'hunter2', hosts: ['shop.example.com'] } }

test('secret values are replaced everywhere in a result', () => {
  const page = {
    text: 'Welcome back. Your password hunter2 is wrong',
    rows: ['hunter2', 'harmless', { nested: { value: 'x hunter2 y' } }],
    count: 3,
  }
  expect(redact(page, SECRETS)).toEqual({
    text: 'Welcome back. Your password [redacted] is wrong',
    rows: ['[redacted]', 'harmless', { nested: { value: 'x [redacted] y' } }],
    count: 3,
  })
})

test('short values are left alone, so a page is not redacted into nonsense', () => {
  expect(redact('1 spool of 2', { PIN: { value: '12', hosts: [] } })).toBe('1 spool of 2')
  expect(redact('pin 1234', { PIN: { value: '1234', hosts: [] } })).toBe('pin [redacted]')
  expect(redact(null, { PIN: { value: '1234', hosts: [] } })).toBe(null)
})

test('nothing is touched without secrets', () => {
  expect(redact('hunter2', {})).toBe('hunter2')
  expect(redact({ a: ['b'] }, {})).toEqual({ a: ['b'] })
})
