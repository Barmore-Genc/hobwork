import type { HomeAssistant } from '../homeassistant/client.ts'
import {
  HomeAssistantSettingsError,
  normalizeHomeAssistantUrl,
  probeHomeAssistant,
  type HomeAssistantSettings,
} from '../homeassistant/settings.ts'
import type { Host } from '../host.ts'
import { HttpError, json, readJson } from '../http.ts'
import { listProjects } from '../projects.ts'
import type { Runtime } from '../runtime/runtime.ts'
import type { ApiRoute } from './router.ts'

const PATH = /^\/api\/settings\/homeassistant$/
const SETTLE_MS = 5000

type Body = { url?: unknown; token?: unknown }

function stringField(body: Body, name: 'url' | 'token'): string | undefined {
  const value = body[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`)
  return value
}

// For users only: the token is write-only, and agents can neither see nor
// change where Hobwork connects.
export function homeAssistantSettingsRoutes(options: {
  host: Host
  settings?: HomeAssistantSettings
  ha?: HomeAssistant
  runtime?: Pick<Runtime, 'load'>
}): ApiRoute[] {
  const { host, ha, runtime } = options

  function settings(): HomeAssistantSettings {
    if (!options.settings) throw new HttpError(503, 'This Hobwork server cannot save Home Assistant settings')
    return options.settings
  }

  function view() {
    const s = settings()
    const source = s.source() ?? null
    const saved = s.saved()
    const configured = source !== null
    const status = !ha || !configured
      ? 'unconfigured'
      : ha.status === 'connected'
        ? 'connected'
        : ha.status === 'disconnected'
          ? 'disconnected'
          : 'connecting'
    return {
      source,
      url: source === 'env' ? (s.connection()?.url ?? null) : (saved?.url ?? null),
      tokenSet: configured,
      updatedAt: source === 'settings' ? (saved?.updatedAt ?? null) : null,
      updatedBy: source === 'settings' ? (saved?.updatedBy ?? null) : null,
      status,
      version: status === 'connected' ? (ha?.version ?? null) : null,
      lastError: status === 'connected' ? null : (ha?.lastError ?? null),
    }
  }

  function refuseWhenFromEnv() {
    if (settings().source() === 'env') {
      throw new HttpError(409, 'The Home Assistant connection is set in the server configuration, so it cannot be changed here')
    }
  }

  // Waits a moment for the new connection, so the answer shows whether it works.
  async function reconnect() {
    if (!ha) return
    ha.reload()
    const deadline = Date.now() + SETTLE_MS
    while (Date.now() < deadline && ha.status !== 'connected' && ha.lastError === undefined && ha.status !== 'unconfigured') {
      await new Promise((r) => setTimeout(r, 50))
    }
    // Triggers that failed while HA was not set up are subscribed again.
    for (const { name } of listProjects(host)) {
      await runtime?.load(name).catch((err: unknown) => console.error(`Reloading the entry points of ${name} failed`, err))
    }
  }

  return [
    { method: 'GET', pattern: PATH, handle: ({ res }) => json(res, 200, view()) },
    {
      method: 'PUT',
      pattern: PATH,
      handle: async ({ req, res, user }) => {
        refuseWhenFromEnv()
        const body = ((await readJson(req)) ?? {}) as Body
        try {
          settings().save({ url: stringField(body, 'url') ?? '', token: stringField(body, 'token') }, user.id)
        } catch (err) {
          if (err instanceof HomeAssistantSettingsError) throw new HttpError(400, err.message)
          throw err
        }
        await reconnect()
        json(res, 200, view())
      },
    },
    {
      method: 'DELETE',
      pattern: PATH,
      handle: async ({ res }) => {
        refuseWhenFromEnv()
        settings().clear()
        await reconnect()
        json(res, 200, view())
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/settings\/homeassistant\/test$/,
      handle: async ({ req, res }) => {
        const body = ((await readJson(req)) ?? {}) as Body
        const s = settings()
        const rawUrl = stringField(body, 'url')
        let url: string | undefined
        try {
          url = rawUrl ? normalizeHomeAssistantUrl(rawUrl) : s.connection()?.url
        } catch (err) {
          if (err instanceof HomeAssistantSettingsError) throw new HttpError(400, err.message)
          throw err
        }
        // The saved token only goes to the saved address, never to one typed in.
        const current = s.connection()
        const token = stringField(body, 'token')?.trim() || (current && current.url === url ? current.token : undefined)
        if (!url || !token) throw new HttpError(400, 'Enter the address and a long-lived access token to test')
        json(res, 200, await probeHomeAssistant({ url, token }))
      },
    },
  ]
}
