// Runs against the dev instance from dev/homeassistant (see its README):
// HOBWORK_HA_TESTS=1 pnpm --filter @hobwork/server test src/api/homeassistant-settings
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createHomeAssistant, type HomeAssistant } from '../homeassistant/client.ts'
import { createHomeAssistantSettings } from '../homeassistant/settings.ts'
import { createTestHost } from '../test-host.ts'
import { signedIn, startTestApp, writeHeaders } from '../test-web.ts'

function devConnection(): { url: string; token: string } {
  const envFile = resolve(import.meta.dirname, '../../../dev/homeassistant/.env.local')
  const vars: Record<string, string | undefined> = { ...process.env }
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const i = line.indexOf('=')
      if (i > 0) vars[line.slice(0, i)] ??= line.slice(i + 1)
    }
  }
  const { HOBWORK_HA_URL: url, HOBWORK_HA_TOKEN: token } = vars
  if (!url || !token) throw new Error('Set HOBWORK_HA_URL and HOBWORK_HA_TOKEN or run node dev/homeassistant/setup.ts')
  return { url, token }
}

describe.runIf(process.env.HOBWORK_HA_TESTS === '1')('Home Assistant settings with the dev instance', () => {
  const host = createTestHost()
  const settings = createHomeAssistantSettings({ db: host.db, key: randomBytes(32) })
  const silent = { info() {}, warn() {}, error() {} }
  let ha: HomeAssistant
  let app: Awaited<ReturnType<typeof startTestApp>>
  let headers: Record<string, string>

  beforeAll(async () => {
    ha = createHomeAssistant({ connection: () => settings.connection(), logger: silent })
    ha.start()
    app = await startTestApp(host, { homeAssistant: ha, homeAssistantSettings: settings })
    headers = writeHeaders(signedIn(host).cookie)
  })

  afterAll(async () => {
    await app.close()
    ha.stop()
    host.dispose()
  })

  test('connects with the address and token saved on the settings page', async () => {
    const { url, token } = devConnection()
    const tested = await fetch(`${app.base}/api/settings/homeassistant/test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ url, token }),
    })
    expect(await tested.json()).toMatchObject({ ok: true, version: expect.stringMatching(/^\d{4}\./) })

    const saved = await fetch(`${app.base}/api/settings/homeassistant`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ url, token }),
    })
    expect(await saved.json()).toMatchObject({ source: 'settings', status: 'connected', version: expect.any(String) })
    expect((await ha.getStates()).length).toBeGreaterThan(0)
  })
})
