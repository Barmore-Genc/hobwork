import { afterEach, expect, test, vi } from 'vitest'
import { CLOSE_REPLACED, CLOSE_REVOKED, createDeviceRegistry, DeviceError, type DeviceConnection, type HostMessage } from './registry.ts'

afterEach(() => {
  vi.useRealTimers()
})

function fakeConnection(deviceId: number) {
  const sent: HostMessage[] = []
  const closed: [number, string][] = []
  const connection: DeviceConnection = {
    deviceId,
    send: (message) => sent.push(message),
    close: (code, reason) => closed.push([code, reason]),
  }
  return { connection, sent, closed }
}

test('routes a call to the device and resolves with its result', async () => {
  const registry = createDeviceRegistry()
  const phone = fakeConnection(1)
  registry.attach(phone.connection)
  const result = registry.call(1, 'notifications', 'send', { title: 'Hi' })
  expect(phone.sent).toEqual([{ type: 'call', id: expect.any(String), capability: 'notifications', method: 'send', args: { title: 'Hi' } }])
  const { id } = phone.sent[0] as { id: string }
  registry.result(phone.connection, { id, ok: true, value: { shown: true } })
  expect(await result).toEqual({ shown: true })
})

test("rejects with the app's error code and message", async () => {
  const registry = createDeviceRegistry()
  const phone = fakeConnection(1)
  registry.attach(phone.connection)
  const result = registry.call(1, 'notifications', 'send', {})
  const { id } = phone.sent[0] as { id: string }
  registry.result(phone.connection, { id, ok: false, error: { code: 'not_authorized', message: 'Notifications are off' } })
  await expect(result).rejects.toMatchObject({ code: 'not_authorized', message: 'Notifications are off' })
})

test('a device that is not connected fails right away', async () => {
  const registry = createDeviceRegistry()
  await expect(registry.call(9, 'notifications', 'send', {})).rejects.toMatchObject({ code: 'not_connected' })
})

test('calls time out, and a late result is ignored', async () => {
  vi.useFakeTimers()
  const registry = createDeviceRegistry({ callTimeoutMs: 1000 })
  const phone = fakeConnection(1)
  registry.attach(phone.connection)
  const result = registry.call(1, 'notifications', 'send', {})
  const caught = result.catch((err: unknown) => err)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await caught).toBeInstanceOf(DeviceError)
  expect(await caught).toMatchObject({ code: 'timeout' })
  const { id } = phone.sent[0] as { id: string }
  expect(() => registry.result(phone.connection, { id, ok: true })).not.toThrow()
})

test('one device cannot answer calls sent to another', async () => {
  vi.useFakeTimers()
  const registry = createDeviceRegistry({ callTimeoutMs: 1000 })
  const phone = fakeConnection(1)
  const laptop = fakeConnection(2)
  registry.attach(phone.connection)
  registry.attach(laptop.connection)
  const result = registry.call(1, 'notifications', 'send', {}).catch((err: unknown) => err)
  const { id } = phone.sent[0] as { id: string }
  registry.result(laptop.connection, { id, ok: true, value: 'forged' })
  await vi.advanceTimersByTimeAsync(1000)
  expect(await result).toMatchObject({ code: 'timeout' })
})

test('a new connection replaces the old one, whose calls fail', async () => {
  const registry = createDeviceRegistry()
  const first = fakeConnection(1)
  registry.attach(first.connection)
  const pending = registry.call(1, 'notifications', 'send', {}).catch((err: unknown) => err)
  const second = fakeConnection(1)
  registry.attach(second.connection)
  expect(first.closed).toEqual([[CLOSE_REPLACED, 'Replaced by a newer connection']])
  expect(await pending).toMatchObject({ code: 'disconnected' })

  // The old connection closing afterwards does not take the new one down.
  registry.detach(first.connection)
  expect(registry.connected(1)).toBe(true)
  const next = registry.call(1, 'notifications', 'send', {})
  registry.result(second.connection, { id: (second.sent[0] as { id: string }).id, ok: true, value: 1 })
  expect(await next).toBe(1)
})

test('disconnect closes the connection and fails its calls', async () => {
  const registry = createDeviceRegistry()
  const phone = fakeConnection(1)
  registry.attach(phone.connection)
  const pending = registry.call(1, 'notifications', 'send', {}).catch((err: unknown) => err)
  registry.disconnect(1, CLOSE_REVOKED, 'Removed')
  expect(phone.closed).toEqual([[CLOSE_REVOKED, 'Removed']])
  expect(registry.connected(1)).toBe(false)
  expect(await pending).toMatchObject({ code: 'disconnected' })
})
