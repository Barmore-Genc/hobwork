import { expect, test, vi } from 'vitest'
import { DeviceError } from '../src/index.ts'
import { createDeviceClient, type DeviceSend } from '../src/runner/device-client.ts'
import { createTestContext } from '../src/testing.ts'

test('sends notifications and lists devices through the host', async () => {
  const requests: unknown[] = []
  const send: DeviceSend = async (request) => {
    requests.push(request)
    if (request.action === 'list') return { ok: true, result: [{ name: 'kaan-iphone', connected: true }] }
    return { ok: true, result: { id: 'n1', delivery: 'push' } }
  }
  const client = createDeviceClient(send)
  const notification = { title: 'Print done', body: 'Benchy is ready', actions: [{ id: 'ok', title: 'OK' }] }
  expect(await client.device('kaan-iphone').notifications.send(notification)).toEqual({ id: 'n1', delivery: 'push' })
  expect(await client.devices()).toEqual([{ name: 'kaan-iphone', connected: true }])
  expect(requests).toEqual([
    { action: 'call', device: 'kaan-iphone', capability: 'notifications', method: 'send', args: notification },
    { action: 'list' },
  ])
})

test('throws a DeviceError with the code and message', async () => {
  const client = createDeviceClient(async () => ({ ok: false, error: { code: 'unknown_device', message: 'No device called "x"' } }))
  const err = await client.device('x').notifications.send({ title: 'Hi' }).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(DeviceError)
  expect(err).toMatchObject({ name: 'DeviceError', code: 'unknown_device', message: 'No device called "x"' })
})

test('instanceof works across copies of the SDK', async () => {
  const copy = (await import(/* @vite-ignore */ `${new URL('../src/runner/device-client.ts', import.meta.url).href}?copy`)) as typeof import('../src/runner/device-client.ts')
  expect(copy.DeviceError).not.toBe(DeviceError)
  expect(new copy.DeviceError('timeout', 'slow')).toBeInstanceOf(DeviceError)
})

test('createTestContext rejects device calls a test did not stub', async () => {
  const ctx = createTestContext()
  await expect(ctx.device('kaan-iphone').notifications.send({ title: 'Hi' })).rejects.toThrow(
    "ctx.device('kaan-iphone').notifications.send is not stubbed",
  )
  await expect(ctx.devices()).rejects.toThrow('ctx.devices is not stubbed')

  const send = vi.fn(async () => ({ id: 'n1', delivery: 'app' as const }))
  const stubbed = createTestContext({ device: () => ({ notifications: { send } }) })
  await stubbed.device('kaan-iphone').notifications.send({ title: 'Hi' })
  expect(send).toHaveBeenCalledWith({ title: 'Hi' })
})
