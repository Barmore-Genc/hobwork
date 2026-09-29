import { afterEach, beforeEach, expect, test } from 'vitest'
import { getHaServices } from '../homeassistant/services.ts'
import { createProject, getProject } from '../projects.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp, writeHeaders } from '../test-web.ts'

let host: ReturnType<typeof createTestHost>
let app: Awaited<ReturnType<typeof startTestApp>>
let cookie: string

beforeEach(async () => {
  host = createTestHost()
  cookie = signedIn(host).cookie
  await createProject(host, 'lights')
  app = await startTestApp(host)
})

afterEach(async () => {
  await app.close()
  host.dispose()
})

function call(method: string, path: string, body?: unknown) {
  return fetch(`${app.base}${path}`, { method, headers: writeHeaders(cookie), body: body === undefined ? undefined : JSON.stringify(body) })
}

test('people read and replace the services a hob may call', async () => {
  expect(await (await call('GET', '/api/projects/lights/home-assistant-services')).json()).toEqual({ services: [] })
  const saved = await call('PUT', '/api/projects/lights/home-assistant-services', { services: ['Light', 'tts.speak'] })
  expect(saved.status).toBe(200)
  expect(await saved.json()).toEqual({ services: ['light', 'tts.speak'] })
  expect(getHaServices(host.db, getProject(host, 'lights')!.id)).toEqual(['light', 'tts.speak'])
})

test('refuses bad entries, blocked services and unknown hobs', async () => {
  const blocked = await call('PUT', '/api/projects/lights/home-assistant-services', { services: ['homeassistant.restart'] })
  expect(blocked.status).toBe(400)
  expect(await blocked.json()).toEqual({ error: 'homeassistant.restart changes Home Assistant itself, so Hobwork does not let any hob call it' })
  expect((await call('PUT', '/api/projects/lights/home-assistant-services', { services: 'light' })).status).toBe(400)
  expect((await call('GET', '/api/projects/nope/home-assistant-services')).status).toBe(404)
})
