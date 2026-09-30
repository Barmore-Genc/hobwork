import { expect, test, vi } from 'vitest'
import { HomeAssistantError } from '../src/index.ts'
import { createHaClient, type HaSend } from '../src/runner/ha-client.ts'
import type { HaResponse } from '../src/runner/protocol.ts'
import { createTestContext } from '../src/testing.ts'

const KITCHEN = { entity_id: 'light.kitchen', state: 'on', attributes: {}, last_changed: '', last_updated: '' }

test('sends each call as one request and returns the result', async () => {
  const requests: unknown[] = []
  const send: HaSend = async (request) => {
    requests.push(request)
    if (request.action === 'getState') return { ok: true, result: request.entityId === 'light.kitchen' ? KITCHEN : null }
    if (request.action === 'getStates') return { ok: true, result: [KITCHEN] }
    return { ok: true, result: { context: { id: 'c', parent_id: null, user_id: null } } }
  }
  const ha = createHaClient(send)
  expect(await ha.callService('tts', 'speak', { message: 'Hi' }, { entity_id: 'tts.google' })).toMatchObject({ context: { id: 'c' } })
  expect(await ha.getState('light.kitchen')).toEqual(KITCHEN)
  expect(await ha.getState('light.nope')).toBeUndefined()
  expect(await ha.getStates({ domain: 'light' })).toEqual([KITCHEN])
  expect(await ha.fireEvent('spool_empty', { spool: 1 })).toBeUndefined()
  expect(requests).toEqual([
    { action: 'callService', domain: 'tts', service: 'speak', data: { message: 'Hi' }, target: { entity_id: 'tts.google' } },
    { action: 'getState', entityId: 'light.kitchen' },
    { action: 'getState', entityId: 'light.nope' },
    { action: 'getStates', filter: { domain: 'light' } },
    { action: 'fireEvent', eventType: 'spool_empty', data: { spool: 1 } },
  ])
})

test("throws a HomeAssistantError with Home Assistant's code and message", async () => {
  const failure: HaResponse = { ok: false, error: { code: 'service_not_found', message: 'Action light.explode not found' } }
  const ha = createHaClient(async () => failure)
  const err = await ha.callService('light', 'explode').catch((e: unknown) => e)
  expect(err).toBeInstanceOf(HomeAssistantError)
  expect(err).toMatchObject({ name: 'HomeAssistantError', code: 'service_not_found', message: 'Action light.explode not found' })
})

test('retries reads after a timeout, and service calls only when asked', async () => {
  const timeout: HaResponse = { ok: false, error: { code: 'timeout', message: 'slow' } }
  const ok: HaResponse = { ok: true, result: [KITCHEN] }
  const answers: HaResponse[] = []
  const requests: unknown[] = []
  const ha = createHaClient(
    async (request) => {
      requests.push(request)
      return answers.shift() ?? ok
    },
    { retryDelayMs: 1 },
  )

  answers.push(timeout, timeout)
  expect(await ha.getStates(undefined, { timeoutMs: 30_000 })).toEqual([KITCHEN])
  expect(requests).toEqual(Array(3).fill({ action: 'getStates', timeoutMs: 30_000 }))

  answers.push(timeout, timeout, timeout)
  await expect(ha.getState('light.kitchen')).rejects.toMatchObject({ code: 'timeout' })

  requests.length = 0
  answers.push(timeout)
  await expect(ha.callService('light', 'toggle')).rejects.toMatchObject({ code: 'timeout' })
  expect(requests).toHaveLength(1)

  requests.length = 0
  answers.push(timeout)
  await ha.callService('recorder', 'get_statistics', {}, undefined, { returnResponse: true, retries: 2 })
  expect(requests).toHaveLength(2)

  requests.length = 0
  answers.push({ ok: false, error: { code: 'service_not_found', message: 'nope' } })
  await expect(ha.callService('recorder', 'nope', {}, undefined, { retries: 2 })).rejects.toMatchObject({ code: 'service_not_found' })
  expect(requests).toHaveLength(1)
})

test('instanceof works across copies of the SDK', async () => {
  // The runner and the handler bundle each load their own copy of the class.
  const copy = (await import(/* @vite-ignore */ `${new URL('../src/runner/ha-client.ts', import.meta.url).href}?copy`)) as typeof import('../src/runner/ha-client.ts')
  expect(copy.HomeAssistantError).not.toBe(HomeAssistantError)
  expect(new copy.HomeAssistantError('timeout', 'slow')).toBeInstanceOf(HomeAssistantError)
  expect(new Error('plain')).not.toBeInstanceOf(HomeAssistantError)
})

test('createTestContext fakes ctx.ha and rejects what a test did not stub', async () => {
  const callService = vi.fn(async () => ({ context: { id: 'c', parent_id: null, user_id: null } }))
  const ctx = createTestContext({ ha: { callService } })
  await ctx.ha.callService('light', 'turn_on', undefined, { entity_id: 'light.kitchen' })
  expect(callService).toHaveBeenCalledWith('light', 'turn_on', undefined, { entity_id: 'light.kitchen' })
  await expect(ctx.ha.getState('light.kitchen')).rejects.toThrow('ctx.ha.getState is not stubbed')
})
