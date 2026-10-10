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

test('failures keep their reason', async () => {
  bridge = createFakeBridge({
    'nfc.write': () => {
      throw new NativeError('failed', 'This tag is too small for the link', 'too_small')
    },
  })
  const error = await rejection(native.nfc.write({ url: 'https://example.com/spool/78', alertMessage: 'Hold it near spool 78' }))
  expect(error).toMatchObject({ code: 'failed', reason: 'too_small' })
  expect(bridge.calls[0]!.args).toEqual({ url: 'https://example.com/spool/78', alertMessage: 'Hold it near spool 78' })
})

test('an NFC session streams tags until it ends, and onTag can change the sheet', async () => {
  bridge = createFakeBridge({
    'nfc.startSession': () => {
      // A tag that arrives before the call answers still reaches the page.
      bridge!.emit('nfc.tag', { session: 's1', records: [{ type: 'url', value: 'https://example.com/bin/4' }], uid: '04aa' })
      return { session: 's1' }
    },
    'nfc.updateSession': () => null,
    'nfc.stopSession': () => null,
  })
  const tags: unknown[] = []
  const ends: unknown[] = []
  const session = await native.nfc.session({
    alertMessage: 'Tap a bin',
    keepOpen: true,
    onTag: (tag) => {
      tags.push(tag)
      return 'Now tap the spool'
    },
    onEnd: (end) => ends.push(end),
  })
  bridge.emit('nfc.tag', { session: 'other', records: [], uid: '04bb' })
  bridge.emit('nfc.tag', { session: 's1', records: [], uid: '04cc' })
  await new Promise((r) => setTimeout(r, 0))
  await session.stop('Done')
  bridge.emit('nfc.ended', { session: 's1', reason: 'timeout' })
  expect(await session.ended).toEqual({ reason: 'timeout' })
  bridge.emit('nfc.tag', { session: 's1', records: [], uid: '04dd' })
  expect(tags).toEqual([
    { records: [{ type: 'url', value: 'https://example.com/bin/4' }], uid: '04aa' },
    { records: [], uid: '04cc' },
  ])
  expect(ends).toEqual([{ reason: 'timeout' }])
  expect(bridge.calls.map((c) => [c.method, c.args])).toEqual([
    ['startSession', { alertMessage: 'Tap a bin', keepOpen: true }],
    ['updateSession', { session: 's1', alertMessage: 'Now tap the spool' }],
    ['updateSession', { session: 's1', alertMessage: 'Now tap the spool' }],
    ['stopSession', { session: 's1', successMessage: 'Done' }],
  ])
})

test('alarm timers and their events', async () => {
  bridge = createFakeBridge({ 'alarms.timer': () => ({ id: 'a1' }), 'alarms.reschedule': () => ({ id: 'a1' }) })
  expect(await native.alarms.timer({ title: 'Oven', seconds: 2700, repeat: { seconds: 900, title: '+15 min' } })).toEqual({ id: 'a1' })
  await native.alarms.reschedule({ id: 'a1', repeat: null })
  const fired: unknown[] = []
  const stop = native.alarms.on('fired', (alarm) => fired.push(alarm))
  bridge.emit('alarms.fired', { id: 'a1', title: 'Oven' })
  stop()
  bridge.emit('alarms.fired', { id: 'a1' })
  expect(fired).toEqual([{ id: 'a1', title: 'Oven' }])
  expect(bridge.calls[1]!.args).toEqual({ id: 'a1', repeat: null })
})

test('share sends the file as data', async () => {
  bridge = createFakeBridge({ 'share.show': () => ({ activity: null }) })
  await native.share({ file: new Uint8Array([1, 2, 3]), filename: 'label.pdf' })
  expect(bridge.calls[0]!.args).toEqual({ filename: 'label.pdf', data: 'AQID' })
})

const code = { id: 'c1', payload: '042853002314', symbology: 'upca', bounds: { x: 0.2, y: 0.4, width: 0.6, height: 0.1 } }

test('a camera scan streams codes, buttons and shutter photos, and captures as a Blob', async () => {
  bridge = createFakeBridge({
    'camera.startScan': () => {
      bridge!.emit('camera.codes', { session: 's1', codes: [code] })
      return { session: 's1' }
    },
    'camera.capture': () => ({ data: 'AQID', type: 'image/jpeg', width: 1600, height: 1200 }),
    'camera.setTorch': () => null,
    'camera.updateScan': () => null,
    'camera.stopScan': () => null,
  })
  const codes: unknown[] = []
  const buttons: string[] = []
  const photos: { width: number; size: number }[] = []
  const scan = await native.camera.scan({
    symbologies: ['upca', 'ean13', 'qr'],
    multiple: true,
    shutter: true,
    buttons: [{ id: 'ai', label: 'Read the label with AI' }],
    onCodes: (c) => codes.push(c),
    onButton: (id) => buttons.push(id),
    onPhoto: (photo) => photos.push({ width: photo.width, size: photo.blob.size }),
  })
  bridge.emit('camera.button', { session: 'other', id: 'ai' })
  bridge.emit('camera.button', { session: 's1', id: 'ai' })
  bridge.emit('camera.photo', { session: 's1', data: 'AQIDBA==', type: 'image/jpeg', width: 800, height: 600 })
  const photo = await scan.capture({ maxDimension: 1600, quality: 0.7 })
  expect(photo.blob.type).toBe('image/jpeg')
  expect([...new Uint8Array(await photo.blob.arrayBuffer())]).toEqual([1, 2, 3])
  expect(photo.width).toBe(1600)
  await scan.setTorch(true)
  await scan.setGuidance('Barcode found')
  await scan.stop()
  bridge.emit('camera.ended', { session: 's1', reason: 'stopped' })
  expect(await scan.ended).toEqual({ reason: 'stopped' })
  bridge.emit('camera.codes', { session: 's1', codes: [] })
  expect(codes).toEqual([[code]])
  expect(buttons).toEqual(['ai'])
  expect(photos).toEqual([{ width: 800, size: 4 }])
  expect(bridge.calls.map((c) => [c.method, c.args])).toEqual([
    [
      'startScan',
      { symbologies: ['upca', 'ean13', 'qr'], multiple: true, shutter: true, buttons: [{ id: 'ai', label: 'Read the label with AI' }] },
    ],
    ['capture', { session: 's1', maxDimension: 1600, quality: 0.7 }],
    ['setTorch', { session: 's1', on: true }],
    ['updateScan', { session: 's1', guidance: 'Barcode found' }],
    ['stopScan', { session: 's1' }],
  ])
})

test('scanCode resolves with the code read, null when closed, and rejects when the camera fails', async () => {
  let end: Record<string, unknown> = { reason: 'selected', code }
  bridge = createFakeBridge({
    'camera.startScan': () => {
      setTimeout(() => bridge!.emit('camera.ended', { session: 's1', ...end }), 0)
      return { session: 's1' }
    },
  })
  expect(await native.camera.scanCode({ symbologies: ['upca'] })).toEqual(code)
  expect(bridge.calls[0]!.args).toEqual({ symbologies: ['upca'], multiple: false })
  end = { reason: 'cancelled' }
  expect(await native.camera.scanCode()).toBeNull()
  end = { reason: 'failed', message: 'The camera stopped' }
  expect(await rejection(native.camera.scanCode())).toMatchObject({ code: 'failed', message: 'The camera stopped' })
})

test('camera photos and their errors', async () => {
  bridge = createFakeBridge({
    'camera.photo': (args) => {
      if ((args as { quality?: number }).quality === 0.1) throw new NativeError('cancelled', 'No photo was taken')
      return { data: 'AQID', type: 'image/jpeg', width: 3, height: 1 }
    },
  })
  const photo = await native.camera.photo({ maxDimension: 1600 })
  expect(photo.blob.size).toBe(3)
  expect((await rejection(native.camera.photo({ quality: 0.1 }))).code).toBe('cancelled')
  expect(native.has('camera', 'startScan')).toBe(false)
  expect((await rejection(native.camera.scan())).code).toBe('unavailable')
})

test('Live Activities start on this device and update and end through the app', async () => {
  bridge = createFakeBridge({
    'liveActivities.status': () => ({ enabled: true, frequentPushes: false }),
    'liveActivities.start': () => ({ id: 'hand' }),
    'liveActivities.update': () => ({ updated: true, devices: [] }),
    'liveActivities.end': () => ({ ended: true, devices: [] }),
  })
  expect(await native.liveActivities.status()).toEqual({ enabled: true, frequentPushes: false })
  const hand = { id: 'hand', title: '3 spools from the dryer', subtitle: 'Bin 5 twice and Bin 7', button: { title: 'Put all away', route: '/hand/put-away' } }
  expect(await native.liveActivities.start(hand)).toEqual({ id: 'hand' })
  await native.liveActivities.update('hand', { subtitle: null })
  await native.liveActivities.end('hand', { dismissAt: 'now' })
  expect(bridge.calls.slice(1)).toEqual([
    { capability: 'liveActivities', method: 'start', args: hand },
    { capability: 'liveActivities', method: 'update', args: { id: 'hand', changes: { subtitle: null } } },
    { capability: 'liveActivities', method: 'end', args: { id: 'hand', dismissAt: 'now' } },
  ])
})
