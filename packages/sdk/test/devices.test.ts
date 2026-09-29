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

test('capability methods are calls to the host with their arguments', async () => {
  const requests: unknown[] = []
  const client = createDeviceClient(async (request) => {
    requests.push(request)
    return { ok: true, result: { id: 'a1' } }
  })
  const phone = client.device('kaan-iphone')
  expect(await phone.alarms.set({ title: 'Wake up', time: '07:00', days: ['mon'] })).toEqual({ id: 'a1' })
  await phone.screenTime.block({ set: 'social' })
  await phone.focus.status()
  expect(requests).toEqual([
    { action: 'call', device: 'kaan-iphone', capability: 'alarms', method: 'set', args: { title: 'Wake up', time: '07:00', days: ['mon'] } },
    { action: 'call', device: 'kaan-iphone', capability: 'screenTime', method: 'block', args: { set: 'social' } },
    { action: 'call', device: 'kaan-iphone', capability: 'focus', method: 'status', args: undefined },
  ])
})

test('createTestContext takes partial device fakes and rejects the rest', async () => {
  const block = vi.fn(async () => ({}))
  const ctx = createTestContext({ device: () => ({ screenTime: { block } }) })
  await ctx.device('kaan-iphone').screenTime.block({ set: 'social' })
  expect(block).toHaveBeenCalledWith({ set: 'social' })
  await expect(ctx.device('kaan-iphone').screenTime.unblock({ set: 'social' })).rejects.toThrow(
    "ctx.device('kaan-iphone').screenTime.unblock is not stubbed",
  )
  await expect(ctx.device('kaan-iphone').alarms.list()).rejects.toThrow('Pass device: (name) => ({ alarms: { list } })')
})
