import { afterEach, expect, test, vi } from 'vitest'
import { createFakeBridge, native, NativeError, type FakeBridge } from '../src/native/index.ts'
import { encodeData } from '../src/native/bridge.ts'
import { mediaPoints } from '../src/native/print.ts'

let bridge: FakeBridge | undefined

afterEach(() => {
  bridge?.uninstall()
  bridge = undefined
  vi.unstubAllGlobals()
})

async function rejection(promise: Promise<unknown>): Promise<NativeError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(NativeError)
    return err as NativeError
  }
  throw new Error('expected a rejection')
}

test('outside the app everything is unavailable', async () => {
  expect(native.available).toBe(false)
  expect(native.platform).toBeUndefined()
  expect(native.has('haptics')).toBe(false)
  const error = await rejection(native.haptics.success())
  expect(error.code).toBe('unavailable')
  const stop = native.on('nfc.scan', () => {})
  expect(() => stop()).not.toThrow()
})

test('feature detection follows the capabilities the app lists', () => {
  bridge = createFakeBridge({ 'haptics.success': () => null, 'print.pdf': () => null }, 'macos')
  expect(native.available).toBe(true)
  expect(native.platform).toBe('macos')
  expect(native.has('haptics')).toBe(true)
  expect(native.has('print', 'pdf')).toBe(true)
  expect(native.has('print', 'pickPrinter')).toBe(false)
  expect(native.has('nfc')).toBe(false)
})

test('a method the app does not list rejects without calling it', async () => {
  bridge = createFakeBridge({ 'haptics.success': () => null })
  expect((await rejection(native.haptics.warning())).code).toBe('unavailable')
  expect(bridge.calls).toEqual([])
})

test('calls send their arguments and resolve with the value', async () => {
  bridge = createFakeBridge({
    'haptics.impact': () => null,
    'clipboard.read': () => ({ text: 'https://example.com/model', url: 'https://example.com/model' }),
    'clipboard.write': () => null,
    'app.info': () => ({ platform: 'ios', hob: 'filament', person: { id: 1, name: 'Kaan' } }),
  })
  await native.haptics.impact('rigid', 0.5)
  await native.haptics.impact()
  expect(await native.clipboard.read()).toEqual({ text: 'https://example.com/model', url: 'https://example.com/model' })
  await native.clipboard.writeText('PLA Black')
  expect((await native.app.info()).person).toEqual({ id: 1, name: 'Kaan' })
  expect(bridge.calls).toEqual([
    { capability: 'haptics', method: 'impact', args: { style: 'rigid', intensity: 0.5 } },
    { capability: 'haptics', method: 'impact', args: { style: 'medium' } },
    { capability: 'clipboard', method: 'read', args: null },
    { capability: 'clipboard', method: 'write', args: { text: 'PLA Black' } },
    { capability: 'app', method: 'info', args: null },
  ])
})

test('errors keep the code the app sent, and unknown codes become failed', async () => {
  bridge = createFakeBridge({
    'clipboard.read': () => {
      throw new NativeError('denied', 'Not allowed for filament')
    },
    'share.show': () => {
      throw new NativeError('cancelled', 'Sharing was cancelled')
    },
    'haptics.tick': () => {
      throw new Error('boom')
    },
  })
  const denied = await rejection(native.clipboard.read())
  expect(denied.code).toBe('denied')
  expect(denied.message).toBe('Not allowed for filament')
  expect((await rejection(native.share({ text: 'hi' }))).code).toBe('cancelled')
  expect((await rejection(native.haptics.tick())).code).toBe('failed')

  globalThis.hobworkNative = {
    ...bridge,
    call: async () => ({ ok: false, error: { code: 'weird', message: 'odd' } }),
  }
  expect((await rejection(native.haptics.tick())).code).toBe('failed')
  globalThis.hobworkNative = { ...bridge, call: () => Promise.reject(new Error('handler gone')) }
  const thrown = await rejection(native.haptics.tick())
  expect([thrown.code, thrown.message]).toEqual(['failed', 'handler gone'])
})

test('events reach listeners until they stop', () => {
  bridge = createFakeBridge({})
  const seen: unknown[] = []
  const stop = native.on<{ tag: string }>('nfc.scan', (scan) => seen.push(scan.tag))
  bridge.emit('nfc.scan', { tag: 'a' })
  bridge.emit('nfc.other', { tag: 'x' })
  stop()
  bridge.emit('nfc.scan', { tag: 'b' })
  expect(seen).toEqual(['a'])
})

test('files go to the app as base64', async () => {
  expect(await encodeData(new Uint8Array([1, 2, 3]))).toBe('AQID')
  expect(await encodeData(new Uint8Array([0, 1, 2, 3]).subarray(1))).toBe('AQID')
  expect(await encodeData(new Uint8Array([104, 105]).buffer)).toBe('aGk=')
  expect(await encodeData(new Blob(['hi']))).toBe('aGk=')
  const large = new Uint8Array(100_000).fill(65)
  expect(atob(await encodeData(large)).length).toBe(100_000)
})

test('URLs are fetched from the hob origin only', async () => {
  vi.stubGlobal('location', new URL('https://filament.apps.example.com/spools'))
  const fetch = vi.fn(async (_url: URL, _init: RequestInit) => new Response(new Uint8Array([1, 2, 3])))
  vi.stubGlobal('fetch', fetch)
  expect(await encodeData('/labels/42.pdf')).toBe('AQID')
  expect(String(fetch.mock.calls[0]![0])).toBe('https://filament.apps.example.com/labels/42.pdf')
  expect(fetch.mock.calls[0]![1].credentials).toBe('same-origin')
  expect((await rejection(encodeData('https://example.com/x.pdf'))).code).toBe('failed')
  fetch.mockResolvedValueOnce(new Response('missing', { status: 404 }))
  expect((await rejection(encodeData('/labels/43.pdf'))).message).toContain('404')
})

test('print sends the PDF and the paper size in points', async () => {
  bridge = createFakeBridge({
    'print.pdf': () => ({ printer: { id: 'ipp://label.local', name: 'Label', lastUsedAt: '2026-10-09T10:00:00Z' }, paper: null }),
  })
  const result = await native.print.pdf(new Uint8Array([37, 80, 68, 70]), {
    mediaSize: { width: 62, height: 29, unit: 'mm' },
    printer: 'ipp://label.local',
  })
  expect(result.printer?.name).toBe('Label')
  const args = bridge.calls[0]!.args as { data: string; mediaSize: { width: number; height: number }; printer: string }
  expect(args.data).toBe('JVBERg==')
  expect(args.printer).toBe('ipp://label.local')
  expect(args.mediaSize.width).toBeCloseTo(175.748, 2)
  expect(mediaPoints({ width: 2, height: 1, unit: 'in' })).toEqual({ width: 144, height: 72 })
  expect(mediaPoints({ width: 100, height: 50 })).toEqual({ width: 100, height: 50 })
})

test('local notifications send deliverAt as an ISO date', async () => {
  bridge = createFakeBridge({ 'notifications.schedule': () => ({ id: 'dryer' }), 'notifications.cancel': () => null })
  const at = new Date('2026-10-09T12:00:00Z')
  expect(await native.notifications.schedule({ id: 'dryer', title: 'Dryer done', deliverAt: at })).toEqual({ id: 'dryer' })
  await native.notifications.cancel('dryer')
  expect(bridge.calls.map((c) => c.args)).toEqual([
    { id: 'dryer', title: 'Dryer done', deliverAt: '2026-10-09T12:00:00.000Z' },
    { id: 'dryer' },
  ])
})

test('share sends the file as data', async () => {
  bridge = createFakeBridge({ 'share.show': () => ({ activity: null }) })
  await native.share({ file: new Uint8Array([1, 2, 3]), filename: 'label.pdf' })
  expect(bridge.calls[0]!.args).toEqual({ filename: 'label.pdf', data: 'AQID' })
})
