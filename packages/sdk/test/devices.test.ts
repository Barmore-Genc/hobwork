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
  await phone.alarms.cancel({ id: 'a1' })
  await phone.focus.status()
  await phone.alarms.reschedule({ id: 'a1', repeat: null })
  expect(requests).toEqual([
    { action: 'call', device: 'kaan-iphone', capability: 'alarms', method: 'set', args: { title: 'Wake up', time: '07:00', days: ['mon'] } },
    { action: 'call', device: 'kaan-iphone', capability: 'alarms', method: 'cancel', args: { id: 'a1' } },
    { action: 'call', device: 'kaan-iphone', capability: 'focus', method: 'status', args: undefined },
    { action: 'call', device: 'kaan-iphone', capability: 'alarms', method: 'reschedule', args: { id: 'a1', repeat: null } },
  ])
})

test('createTestContext takes partial device fakes and rejects the rest', async () => {
  const cancel = vi.fn(async () => ({}))
  const ctx = createTestContext({ device: () => ({ alarms: { cancel } }) })
  await ctx.device('kaan-iphone').alarms.cancel({ id: 'a1' })
  expect(cancel).toHaveBeenCalledWith({ id: 'a1' })
  await expect(ctx.device('kaan-iphone').alarms.timer({ title: 'Tea', seconds: 60 })).rejects.toThrow(
    "ctx.device('kaan-iphone').alarms.timer is not stubbed",
  )
  await expect(ctx.device('kaan-iphone').alarms.list()).rejects.toThrow('Pass device: (name) => ({ alarms: { list } })')
})

const device = (name: string, ownerId: number, lastActiveAt: string | null, lastSeenAt: string | null = lastActiveAt) => ({
  name,
  platform: 'ios' as const,
  owner: `person ${ownerId}`,
  ownerId,
  capabilities: [],
  connected: false,
  lastSeenAt,
  lastActiveAt,
})

test('people and a person’s devices go through the host; the last active device is the first one', async () => {
  const requests: unknown[] = []
  const client = createDeviceClient(async (request) => {
    requests.push(request)
    if (request.action === 'people') return { ok: true, result: [{ id: 1, name: 'Kaan', email: null, timeZone: 'UTC' }] }
    return { ok: true, result: [device('kaan-mac', 1, '2026-10-09T10:00:00.000Z'), device('kaan-iphone', 1, null)] }
  })
  expect(await client.people()).toEqual([{ id: 1, name: 'Kaan', email: null, timeZone: 'UTC' }])
  expect((await client.person(1).lastActiveDevice())?.name).toBe('kaan-mac')
  expect(requests).toEqual([{ action: 'people' }, { action: 'list', person: 1 }])

  const nobody = createDeviceClient(async () => ({ ok: true, result: [] }))
  expect(await nobody.person(2).lastActiveDevice()).toBeUndefined()
})

test('createTestContext answers ctx.person from the stubbed devices, most recently used first', async () => {
  const ctx = createTestContext({
    devices: async () => [
      device('kaan-iphone', 1, '2026-10-09T08:00:00.000Z'),
      device('kaan-mac', 1, '2026-10-09T09:00:00.000Z'),
      device('ece-iphone', 2, '2026-10-09T10:00:00.000Z'),
      device('kaan-ipad', 1, null, '2026-10-09T11:00:00.000Z'),
    ],
  })
  expect(ctx.caller).toBeNull()
  expect((await ctx.person(1).devices()).map((d) => d.name)).toEqual(['kaan-mac', 'kaan-iphone', 'kaan-ipad'])
  expect((await ctx.person(1).lastActiveDevice())?.name).toBe('kaan-mac')
  await expect(ctx.people()).rejects.toThrow('ctx.people is not stubbed')
})

test('person notifications, updates and withdrawals go through the host', async () => {
  const requests: unknown[] = []
  const client = createDeviceClient(async (request) => {
    requests.push(request)
    if (request.action === 'notify') return { ok: true, result: { id: 'print:1', scheduled: false, devices: [{ device: 'kaan-iphone', delivery: 'push' }] } }
    if (request.action === 'updateNotification') return { ok: true, result: { updated: true, devices: [] } }
    return { ok: true, result: { withdrawn: true } }
  })
  const notification = { id: 'print:1', title: 'Gojira stopped', interruptionLevel: 'timeSensitive' as const, devices: 'lastActive' as const }
  expect(await client.person(1).notifications.send(notification)).toEqual({
    id: 'print:1',
    scheduled: false,
    devices: [{ device: 'kaan-iphone', delivery: 'push' }],
  })
  expect(await client.notifications.update('print:1', { body: 'Tray 3 would not feed.' })).toEqual({ updated: true, devices: [] })
  expect(await client.notifications.withdraw('print:1')).toEqual({ withdrawn: true })
  expect(requests).toEqual([
    { action: 'notify', person: 1, args: notification },
    { action: 'updateNotification', id: 'print:1', args: { body: 'Tray 3 would not feed.' } },
    { action: 'withdrawNotification', id: 'print:1' },
  ])
})

test('createTestContext rejects notification calls a test did not stub and takes fakes', async () => {
  const withdraw = vi.fn(async () => ({ withdrawn: true }))
  const send = vi.fn(async () => ({ id: 'n', scheduled: false, devices: [] }))
  const ctx = createTestContext({ notifications: { withdraw }, personNotifications: () => ({ send }) })
  expect(await ctx.notifications.withdraw('n')).toEqual({ withdrawn: true })
  expect(await ctx.person(2).notifications.send({ title: 'Hi' })).toEqual({ id: 'n', scheduled: false, devices: [] })
  expect(send).toHaveBeenCalledWith({ title: 'Hi' })
  await expect(ctx.notifications.update('n', {})).rejects.toThrow('ctx.notifications.update is not stubbed')
  await expect(createTestContext().person(1).notifications.send({ title: 'Hi' })).rejects.toThrow('ctx.person(1).notifications.send is not stubbed')
})

test('Live Activities and widget reloads go through the host for a device, a person or everywhere', async () => {
  const requests: unknown[] = []
  const client = createDeviceClient(async (request) => {
    requests.push(request)
    return { ok: true, result: {} }
  })
  const activity = { id: 'dryer', title: 'Dryer', endsAt: '2026-10-09T14:00:00Z' }
  await client.person(1).liveActivities.start({ ...activity, devices: 'lastActive' })
  await client.device('kaan-iphone').liveActivities.update('dryer', { progress: 0.5 })
  await client.person(1).liveActivities.end('dryer', { dismissAt: 'now' })
  await client.liveActivities.end('dryer')
  await client.person(1).widgets.reload()
  await client.device('kaan-iphone').widgets.reload()
  expect(requests).toEqual([
    { action: 'liveActivity', op: 'start', person: 1, args: { ...activity, devices: 'lastActive' } },
    { action: 'liveActivity', op: 'update', device: 'kaan-iphone', id: 'dryer', args: { progress: 0.5 } },
    { action: 'liveActivity', op: 'end', person: 1, id: 'dryer', args: { dismissAt: 'now' } },
    { action: 'liveActivity', op: 'end', id: 'dryer', args: {} },
    { action: 'reloadWidgets', person: 1 },
    { action: 'reloadWidgets', device: 'kaan-iphone' },
  ])
})

test('createTestContext rejects Live Activity and widget calls a test did not stub and takes fakes', async () => {
  const start = vi.fn(async () => ({ id: 'dryer', devices: [] }))
  const end = vi.fn(async () => ({ ended: true, devices: [] }))
  const ctx = createTestContext({ personLiveActivities: () => ({ start }), liveActivities: { end } })
  expect(await ctx.person(1).liveActivities.start({ id: 'dryer', title: 'Dryer' })).toEqual({ id: 'dryer', devices: [] })
  expect(await ctx.liveActivities.end('dryer')).toEqual({ ended: true, devices: [] })
  await expect(ctx.liveActivities.update('dryer', {})).rejects.toThrow('ctx.liveActivities.update is not stubbed')
  await expect(ctx.person(1).widgets.reload()).rejects.toThrow('ctx.person(1).widgets.reload is not stubbed')
  await expect(ctx.device('kaan-iphone').liveActivities.start({ id: 'a', title: 'A' })).rejects.toThrow('is not stubbed')
})
