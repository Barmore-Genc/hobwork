import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { ApiRoute } from '../api/router.ts'
import type { Auth } from '../auth/auth.ts'
import { getUser, isAllowed } from '../auth/users.ts'
import { DEFAULT_APPLE_APP_ID, type Allowlist } from '../config.ts'
import { HttpError, json, readJson, redirect } from '../http.ts'
import type { Devices } from './devices.ts'
import { createNfcPage, NFC_PATH, page } from './nfc-page.ts'
import { deviceFromRequest, parsePush } from './socket.ts'
import {
  createPairingCode,
  createWebSessionLink,
  DEVICE_LINK_PATH,
  DeviceStoreError,
  deviceNameError,
  deviceNameTaken,
  exchangePairingCode,
  freeDeviceName,
  isPlatform,
  PAIRED_PATH,
  PAIRING_REDIRECT_URI,
  pairedUniversalLink,
  redeemWebSessionLink,
  renameDevice,
  setPushToken,
  touchDevice,
  type Device,
} from './store.ts'

// The app checks the address a person typed with this before pairing.
export const DISCOVERY_PATH = '/.well-known/hobwork'
// Lets the app open tag URLs (universal links) when it is built with this host
// in its Associated Domains.
export const AASA_PATH = '/.well-known/apple-app-site-association'
const HOST_VERSION = String(
  (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version,
)
const TOKEN_PATH = '/api/devices/token'
const WEB_SESSION_PATH = '/api/devices/web-session'
const PUSH_PATH = '/api/devices/push'
const EVENTS_PATH = '/api/devices/events'
const RESULTS_PATH = '/api/devices/results'
// Health samples and query results are larger than other bodies.
const MAX_DEVICE_BODY_BYTES = 1024 * 1024
const SELF_PATH = '/api/devices/self'
const MAX_DISPLAY_NAME = 100
const MAX_STATE = 512
const MAX_RETURN_TO = 2048

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

type PairingParams = {
  displayName: string
  platform: 'ios' | 'macos'
  challenge: string
  state: string | null
  redirectUri: string
}

// Checks the query the app opened /devices/connect with. The redirect URI is
// one of two fixed ones, so a page elsewhere cannot start a pairing that hands
// the code to itself.
function pairingParams(input: Record<string, unknown>, publicUrl: string): PairingParams {
  const redirectUri = input.redirect_uri
  if (redirectUri !== pairedUniversalLink(publicUrl) && redirectUri !== PAIRING_REDIRECT_URI) {
    throw new HttpError(400, `redirect_uri must be ${pairedUniversalLink(publicUrl)}`)
  }
  const displayName = string(input.name)?.trim()
  if (!displayName || displayName.length > MAX_DISPLAY_NAME) throw new HttpError(400, 'The app sent no device name')
  if (!isPlatform(input.platform)) throw new HttpError(400, 'The app sent an unknown platform')
  const challenge = string(input.challenge)
  if (!challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    throw new HttpError(400, 'The app sent no valid PKCE challenge (S256, base64url)')
  }
  const state = input.state === undefined || input.state === null ? null : string(input.state)
  if (state === undefined || (state !== null && state.length > MAX_STATE)) throw new HttpError(400, 'The app sent an invalid state')
  return { displayName, platform: input.platform, challenge, state, redirectUri }
}

function pairedUrl(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value)
  return url.href
}

// A path on the Hobwork origin, never another site.
export function safeReturnTo(value: unknown, publicUrl: string): string | undefined {
  if (value === undefined || value === null || value === '') return '/'
  if (typeof value !== 'string' || value.length > MAX_RETURN_TO) return undefined
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return undefined
  let url: URL
  try {
    url = new URL(value, publicUrl)
  } catch {
    return undefined
  }
  return url.origin === publicUrl ? `${url.pathname}${url.search}${url.hash}` : undefined
}

function deviceId(params: string[]): number {
  return Number(params[0])
}

export function deviceUserRoutes(options: { db: DatabaseSync; devices: Devices; publicUrl: string }): ApiRoute[] {
  const { db, devices, publicUrl } = options
  return [
    {
      method: 'GET',
      pattern: /^\/api\/devices$/,
      handle: ({ res }) => json(res, 200, { devices: devices.list(), push: devices.pushEnabled }),
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/devices\/(\d+)$/,
      async handle({ req, res, params }) {
        const body = await readJson(req)
        const name = isObject(body) && typeof body.name === 'string' ? body.name.trim() : ''
        try {
          renameDevice(db, deviceId(params), name)
        } catch (err) {
          if (err instanceof DeviceStoreError) throw new HttpError(err.status, err.message)
          throw err
        }
        json(res, 200, devices.list().find((d) => d.id === deviceId(params)))
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/devices\/(\d+)\/revoke$/,
      handle({ res, params }) {
        if (!devices.revoke(deviceId(params))) throw new HttpError(404, 'This device does not exist')
        res.writeHead(204).end()
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/devices\/pairing$/,
      handle({ res, query }) {
        const params = pairingParams(Object.fromEntries(query), publicUrl)
        json(res, 200, { displayName: params.displayName, platform: params.platform, name: freeDeviceName(db, params.displayName) })
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/devices\/pairing\/approve$/,
      async handle({ req, res, user }) {
        const body = await readJson(req)
        if (!isObject(body) || !isObject(body.request)) throw new HttpError(400, 'Send { request, name }')
        const params = pairingParams(body.request, publicUrl)
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        const error = deviceNameError(name)
        if (error) throw new HttpError(400, error)
        if (deviceNameTaken(db, name)) throw new HttpError(409, `A device called "${name}" already exists`)
        const code = createPairingCode(db, { userId: user.id, name, platform: params.platform, codeChallenge: params.challenge })
        json(res, 200, { redirectTo: pairedUrl(params.redirectUri, { code, state: params.state }) })
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/devices\/pairing\/deny$/,
      async handle({ req, res }) {
        const body = await readJson(req)
        if (!isObject(body) || !isObject(body.request)) throw new HttpError(400, 'Send { request }')
        const params = pairingParams(body.request, publicUrl)
        json(res, 200, { redirectTo: pairedUrl(params.redirectUri, { error: 'access_denied', state: params.state }) })
      },
    },
  ]
}

// Returns false for paths it does not own.
export function createDeviceRoutes(options: {
  db: DatabaseSync
  auth: Auth
  allowlist: Allowlist
  publicUrl: string
  devices: Devices
  appleAppId?: string
}) {
  const { db, auth, allowlist, publicUrl, devices } = options
  const appleAppId = options.appleAppId ?? DEFAULT_APPLE_APP_ID
  const nfcPage = createNfcPage({ db, auth, publicUrl, devices })

  function requireDevice(req: IncomingMessage): Device {
    const auth = deviceFromRequest(db, allowlist, req)
    if ('refused' in auth) throw new HttpError(auth.refused.status, auth.refused.error)
    return auth.device
  }

  // Signing out in the app, which removes the device like Settings does.
  async function removeSelf(req: IncomingMessage, res: ServerResponse) {
    const device = requireDevice(req)
    devices.revoke(device.id)
    res.writeHead(204).end()
  }

  async function token(req: IncomingMessage, res: ServerResponse) {
    const body = await readJson(req)
    if (!isObject(body)) throw new HttpError(400, 'Send a JSON object')
    const code = string(body.code)
    const verifier = string(body.codeVerifier ?? body.code_verifier)
    if (!code || !verifier) throw new HttpError(400, 'Send code and codeVerifier')
    try {
      const { device, token } = exchangePairingCode(db, code, verifier)
      json(res, 200, { deviceId: device.id, name: device.name, token })
    } catch (err) {
      if (err instanceof DeviceStoreError) throw new HttpError(err.status, err.message)
      throw err
    }
  }

  async function webSession(req: IncomingMessage, res: ServerResponse) {
    const device = requireDevice(req)
    const body = req.headers['content-type'] ? await readJson(req) : {}
    const returnTo = safeReturnTo(isObject(body) ? body.returnTo : undefined, publicUrl)
    if (returnTo === undefined) throw new HttpError(400, 'returnTo must be a path on this Hobwork host, like /projects')
    touchDevice(db, device.id)
    json(res, 200, { url: createWebSessionLink(db, publicUrl, device.id, returnTo) })
  }

  async function push(req: IncomingMessage, res: ServerResponse) {
    const device = requireDevice(req)
    const body = await readJson(req)
    const value = isObject(body) && body.token === null ? null : parsePush(body)
    if (value === undefined) throw new HttpError(400, 'Send { token, environment } with a hex APNs token and "sandbox" or "production"')
    setPushToken(db, device.id, value)
    res.writeHead(204).end()
  }

  async function events(req: IncomingMessage, res: ServerResponse) {
    const device = requireDevice(req)
    const body = await readJson(req, MAX_DEVICE_BODY_BYTES)
    if (!isObject(body)) throw new HttpError(400, 'Send { capability, name, data }')
    touchDevice(db, device.id)
    await devices.handleEvent(device.id, { capability: body.capability, name: body.name, data: body.data })
    res.writeHead(204).end()
  }

  // Command results from the notification service extension, or from the
  // app when HTTP is quicker than connecting.
  async function results(req: IncomingMessage, res: ServerResponse) {
    const device = requireDevice(req)
    const body = await readJson(req, MAX_DEVICE_BODY_BYTES)
    if (!isObject(body) || typeof body.id !== 'string' || typeof body.ok !== 'boolean') {
      throw new HttpError(400, 'Send { id, ok: true, value } or { id, ok: false, error: { code, message } }')
    }
    touchDevice(db, device.id)
    if (devices.handleResult(device.id, body) === 'unknown') throw new HttpError(404, 'This device has no command with this ID')
    res.writeHead(204).end()
  }

  const endpoints: Record<string, { method: string; handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = {
    [TOKEN_PATH]: { method: 'POST', handle: token },
    [WEB_SESSION_PATH]: { method: 'POST', handle: webSession },
    [PUSH_PATH]: { method: 'PUT', handle: push },
    [EVENTS_PATH]: { method: 'POST', handle: events },
    [RESULTS_PATH]: { method: 'POST', handle: results },
    [SELF_PATH]: { method: 'DELETE', handle: removeSelf },
  }

  return async (req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<boolean> => {
    if (pathname === DISCOVERY_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      json(res, 200, { hobwork: 1, name: new URL(publicUrl).hostname, version: HOST_VERSION })
      return true
    }
    if (pathname === AASA_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      // webcredentials lets ASWebAuthenticationSession finish on the pairing link.
      json(res, 200, {
        applinks: { details: [{ appIDs: [appleAppId], components: [{ '/': '/nfc/*' }, { '/': PAIRED_PATH }] }] },
        webcredentials: { apps: [appleAppId] },
      })
      return true
    }
    if (pathname === PAIRED_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      page(
        res,
        200,
        'Pairing',
        '<p>Open the Hobwork app on your phone or Mac to finish pairing. If pairing did not finish, go back to the app and start it again.</p>',
        'Pairing',
      )
      return true
    }
    const nfc = NFC_PATH.exec(pathname)
    if (nfc) {
      await nfcPage(req, res, nfc[1]!, search)
      return true
    }
    if (pathname === DEVICE_LINK_PATH && req.method === 'GET') {
      // The app loads the link itself, which browsers send as "none". A link
      // followed from a page would let that page sign the web view in to the
      // page author's account (login CSRF).
      const site = req.headers['sec-fetch-site']
      if (site !== undefined && site !== 'none') {
        json(res, 403, { error: 'Open this link from the Hobwork app' })
        return true
      }
      const used = redeemLink(search.get('token') ?? '')
      if (!used) {
        redirect(res, '/login?error=link_expired')
        return true
      }
      auth.signIn(res, used.user, { deviceId: used.deviceId })
      redirect(res, used.returnTo)
      return true
    }
    const endpoint = endpoints[pathname]
    if (!endpoint) return false
    if (req.method !== endpoint.method) {
      res.writeHead(405, { allow: endpoint.method }).end()
      return true
    }
    try {
      await endpoint.handle(req, res)
    } catch (err) {
      if (err instanceof HttpError) json(res, err.status, { error: err.message })
      else throw err
    }
    return true
  }

  function redeemLink(token: string) {
    const used = redeemWebSessionLink(db, token)
    if (!used) return undefined
    const user = getUser(db, used.device.userId)
    if (!user || !isAllowed(db, allowlist, user)) return undefined
    return { user, deviceId: used.device.id, returnTo: used.returnTo }
  }
}
