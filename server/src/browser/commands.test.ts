import { expect, test } from 'vitest'
import { BROWSER_DEFAULT_TIMEOUT_MS, BROWSER_MAX_TIMEOUT_MS } from '../../../packages/sdk/src/webbrowser.ts'
import { BrowserBadRequest, evaluateFunction, parseBrowserRequest } from './commands.ts'

const TAB = 'a1b2c3d4e5f60718'

function parse(value: object | string) {
  return parseBrowserRequest(typeof value === 'string' ? value : JSON.stringify(value))
}

function rejects(value: object | string) {
  try {
    parse(value)
  } catch (err) {
    expect(err).toBeInstanceOf(BrowserBadRequest)
    return (err as Error).message
  }
  throw new Error('expected a refusal')
}

test('reads and writes with a tab', () => {
  expect(parse({ action: 'click', tab: TAB, selector: 'role=button[name="Save"]' })).toMatchObject({
    action: 'click',
    tab: TAB,
    selector: 'role=button[name="Save"]',
  })
  expect(parse({ action: 'text', tab: TAB })).toMatchObject({ action: 'text', tab: TAB })
  expect(parse({ action: 'evaluate', tab: TAB, source: '() => 1' })).toMatchObject({ action: 'evaluate', world: 'isolated' })
  expect(parse({ action: 'evaluate', tab: TAB, source: '() => window.x', world: 'main' })).toMatchObject({ world: 'main' })
})

test('open and tabs take no tab', () => {
  expect(parse({ action: 'open', url: 'https://example.com/a?b=1' })).toMatchObject({ action: 'open', url: 'https://example.com/a?b=1' })
  expect(parse({ action: 'tabs' })).toEqual({ action: 'tabs' })
  expect(rejects({ action: 'open', tab: TAB, url: 'https://example.com/' })).toMatch(/does not act on a tab/)
  expect(rejects({ action: 'click', selector: '#a' })).toMatch(/tab must be the ID of a tab of this hob/)
  expect(rejects({ action: 'click', tab: 'nope', selector: '#a' })).toMatch(/tab must be the ID/)
})

test('a URL has to be one, without credentials', () => {
  expect(rejects({ action: 'open', url: 'not a url' })).toMatch(/is not a URL/)
  expect(rejects({ action: 'open', url: 'https://user:pass@example.com/' })).toMatch(/user name or password/)
  expect(rejects({ action: 'goto', tab: TAB, url: `https://example.com/${'a'.repeat(5000)}` })).toMatch(/at most 4096/)
})

test('timeouts are bounded', () => {
  expect(parse({ action: 'text', tab: TAB, timeoutMs: 5000 })).toMatchObject({ timeoutMs: 5000 })
  expect(rejects({ action: 'text', tab: TAB, timeoutMs: 0 })).toMatch(new RegExp(`from 1 to ${BROWSER_MAX_TIMEOUT_MS}`))
  expect(rejects({ action: 'text', tab: TAB, timeoutMs: BROWSER_MAX_TIMEOUT_MS + 1 })).toMatch(/timeoutMs/)
  expect(rejects({ action: 'text', tab: TAB, timeoutMs: 1.5 })).toMatch(/whole number/)
  // The default is applied when a tab runs the command, not here.
  expect(parse({ action: 'text', tab: TAB })).not.toHaveProperty('timeoutMs')
  expect(BROWSER_DEFAULT_TIMEOUT_MS).toBeLessThan(BROWSER_MAX_TIMEOUT_MS)
})

test('typed text may be empty and carries only known placeholders', () => {
  expect(parse({ action: 'fill', tab: TAB, selector: '#email', text: '' })).toMatchObject({ text: '' })
  expect(
    parse({ action: 'fill', tab: TAB, selector: '#password', text: 'hlx-placeholder', secrets: { SHOP_PASSWORD: 'hlx-placeholder' } }),
  ).toMatchObject({ secrets: { SHOP_PASSWORD: 'hlx-placeholder' } })
  expect(parse({ action: 'fill', tab: TAB, selector: '#a', text: 'x' })).toMatchObject({ secrets: {} })
  expect(rejects({ action: 'fill', tab: TAB, selector: '#a', text: 'x', secrets: { 'not a name': 'y' } })).toMatch(/environment name/)
  expect(rejects({ action: 'fill', tab: TAB, selector: '#a', text: 'x', secrets: [] })).toMatch(/must be a JSON object/)
})

test('selectors, values and keys are bounded', () => {
  expect(rejects({ action: 'click', tab: TAB, selector: '' })).toMatch(/must not be empty/)
  expect(rejects({ action: 'select', tab: TAB, selector: '#a', values: [] })).toMatch(/non-empty list/)
  expect(rejects({ action: 'select', tab: TAB, selector: '#a', values: [1] })).toMatch(/must be a string/)
  expect(rejects({ action: 'press', tab: TAB, key: '' })).toMatch(/must not be empty/)
  expect(parse({ action: 'press', tab: TAB, key: 'Enter' })).toEqual({ action: 'press', tab: TAB, key: 'Enter', secrets: {} })
})

test('actions are a fixed list, and the body has to be JSON', () => {
  expect(rejects({ action: 'screenshot', tab: TAB })).toMatch(/is not a browser action/)
  expect(rejects({ action: 'navigate', tab: TAB })).toMatch(/is not a browser action/)
  expect(rejects('{"action":')).toMatch(/JSON/)
  expect(rejects({})).toMatch(/action must be a string/)
  expect(rejects({ action: 'evaluate', tab: TAB, source: 'x', world: 'page' })).toMatch(/world must be/)
})

test('an evaluate source becomes a function the page runs', () => {
  const fn = evaluateFunction('(arg) => ({ doubled: arg * 2 })')
  expect(fn(21)).toEqual({ doubled: 42 })
  // A string body is wrapped the same way, so it has to be a function.
  expect(() => evaluateFunction('1 + 1')(undefined)).toThrow()
})
