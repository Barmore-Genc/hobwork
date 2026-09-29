import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { HomeAssistantConnection } from '../config.ts'
import { webSocketUrl } from './client.ts'

const IV_BYTES = 12
const TAG_BYTES = 16
// Binds the ciphertext to this setting, so it does not decrypt as anything else.
const TOKEN_AAD = Buffer.from('hobwork-setting:v1:homeassistant-token')
const MAX_TOKEN_CHARS = 4096

export class HomeAssistantSettingsError extends Error {}

// env: the connection from HOBWORK_HA_URL and HOBWORK_HA_TOKEN, which wins
// over the one saved in the web UI.
export type HomeAssistantSource = 'env' | 'settings'

export type SavedHomeAssistant = { url: string; updatedAt: string; updatedBy: string | null }

export function normalizeHomeAssistantUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new HomeAssistantSettingsError('Enter the address you open Home Assistant at, like http://homeassistant.local:8123')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HomeAssistantSettingsError('The address must start with http:// or https://')
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new HomeAssistantSettingsError('Enter the address without anything after the host and port')
  }
  return url.toString().replace(/\/$/, '')
}

function validateToken(token: string): string {
  const trimmed = token.trim()
  if (!trimmed) throw new HomeAssistantSettingsError('Enter a long-lived access token')
  if (trimmed.length > MAX_TOKEN_CHARS || /\s/.test(trimmed)) {
    throw new HomeAssistantSettingsError('This does not look like a Home Assistant access token')
  }
  return trimmed
}

export function createHomeAssistantSettings(options: { db: DatabaseSync; key: Buffer; env?: HomeAssistantConnection }) {
  const { db, key, env } = options
  let cached: HomeAssistantConnection | null | undefined

  function encrypt(token: string): Buffer {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(TOKEN_AAD)
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  }

  function decrypt(value: Uint8Array): string {
    const data = Buffer.from(value)
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_BYTES)).setAAD(TOKEN_AAD)
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  }

  function row() {
    return db
      .prepare(
        `SELECT s.url, s.token, s.updated_at, u.name AS updated_by
         FROM homeassistant_settings s LEFT JOIN users u ON u.id = s.updated_by_user_id WHERE s.id = 1`,
      )
      .get()
  }

  function savedConnection(): HomeAssistantConnection | undefined {
    if (cached !== undefined) return cached ?? undefined
    const saved = row()
    cached = null
    if (saved) {
      try {
        cached = { url: String(saved.url), token: decrypt(saved.token as Uint8Array) }
      } catch {
        console.error('The saved Home Assistant access token cannot be decrypted. Was the secret key changed?')
      }
    }
    return cached ?? undefined
  }

  return {
    // What the HA client connects with. Called on every connection attempt.
    connection(): HomeAssistantConnection | undefined {
      return env ?? savedConnection()
    },

    source(): HomeAssistantSource | undefined {
      if (env) return 'env'
      return row() ? 'settings' : undefined
    },

    // The saved setting without its token, which never leaves the host.
    saved(): SavedHomeAssistant | undefined {
      const saved = row()
      if (!saved) return undefined
      return {
        url: String(saved.url),
        updatedAt: String(saved.updated_at),
        updatedBy: saved.updated_by === null ? null : String(saved.updated_by),
      }
    },

    // The token may be left out to keep the saved one.
    save(input: { url: string; token?: string }, userId?: number): void {
      const url = normalizeHomeAssistantUrl(input.url)
      let token: string | undefined
      if (input.token) token = validateToken(input.token)
      else {
        const saved = savedConnection()
        if (saved && saved.url !== url) {
          // The token only goes to the address it was entered for.
          throw new HomeAssistantSettingsError('Enter the access token again when you change the address')
        }
        token = saved?.token
      }
      if (token === undefined) throw new HomeAssistantSettingsError('Enter a long-lived access token')
      db.prepare(
        `INSERT INTO homeassistant_settings (id, url, token, updated_by_user_id) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET url = excluded.url, token = excluded.token,
           updated_by_user_id = excluded.updated_by_user_id, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).run(url, encrypt(token), userId ?? null)
      cached = undefined
    },

    clear(): boolean {
      const { changes } = db.prepare('DELETE FROM homeassistant_settings').run()
      cached = undefined
      return Number(changes) > 0
    },
  }
}

export type HomeAssistantSettings = ReturnType<typeof createHomeAssistantSettings>

export type ProbeResult = { ok: true; version: string | null } | { ok: false; error: string }

// Opens a separate connection and signs in, without touching the host's own
// connection.
export function probeHomeAssistant(connection: HomeAssistantConnection, timeoutMs = 10_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let ws: WebSocket
    let done = false
    const finish = (result: ProbeResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: `Home Assistant did not answer within ${timeoutMs / 1000} seconds` }),
      timeoutMs,
    )
    try {
      ws = new WebSocket(webSocketUrl(connection.url))
    } catch (err) {
      clearTimeout(timer)
      resolve({ ok: false, error: `Cannot connect: ${(err as Error).message}` })
      return
    }
    ws.addEventListener('message', (event) => {
      let message: { type?: string; ha_version?: string; message?: string }
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return finish({ ok: false, error: 'This address does not answer like Home Assistant' })
      }
      if (message.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: connection.token }))
      else if (message.type === 'auth_ok') finish({ ok: true, version: message.ha_version ?? null })
      else if (message.type === 'auth_invalid') finish({ ok: false, error: 'Home Assistant did not accept the access token' })
    })
    ws.addEventListener('close', () => finish({ ok: false, error: 'Cannot connect to Home Assistant at this address' }))
    ws.addEventListener('error', () => {})
  })
}
