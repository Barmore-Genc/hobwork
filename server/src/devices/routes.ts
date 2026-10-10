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
import { SurfaceError } from './hob-surfaces.ts'
import { DeviceError } from './registry.ts'
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
  isUserEvent,
  markDeviceActive,
  PAIRED_PATH,
  PAIRING_REDIRECT_URI,
  pairedUniversalLink,
  redeemWebSessionLink,
  renameDevice,
  setPush,
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
const HANDOFF_PATH = '/api/devices/handoff'
const NFC_LOOKUP_PATH = '/api/devices/nfc/lookup'
const LIVE_ACTIVITIES_PATH = '/api/devices/live-activities'
const HOBS_PATH = '/api/devices/hobs'
const INTENTS_PATH = '/api/devices/intents'
const WIDGET_PATH = /^\/api\/devices\/widgets\/([a-z0-9][a-z0-9-]*)$/
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
  // What the app tells hob UIs about the device and its owner (the bridge's app.info).
  async function describeSelf(req: IncomingMessage, res: ServerResponse) {
    const device = requireDevice(req)
    json(res, 200, { id: device.id, name: device.name, platform: device.platform, person: { id: device.userId, name: device.owner } })
  }

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
      json(res, 200, { deviceId: device.id, name: device.name, token, push: devices.pushInfo() })
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
    const value = isObject(body) && body.grant === null ? null : parsePush(body)
    if (value === undefined) throw new HttpError(400, 'Send { grant, key } with the relay grant ID and a base64 X25519 key, or { grant: null }')
    setPush(db, device.id, value)
    res.writeHead(204).end()
  }

  async function events(req: IncomingMessage, res: ServerResponse) {
    const device = requireDevice(req)
    const body = await readJson(req, MAX_DEVICE_BODY_BYTES)
    if (!isObject(body)) throw new HttpError(400, 'Send { capability, name, data }')
    if (isUserEvent(body.capability, body.name)) markDeviceActive(db, device.id)
    else touchDevice(db, device.id)
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

  // A command for another device of the same person, from a hob page in the
  // app. Answers once that device answered (up to two minutes for NFC), with
  // the outcome in the body, as the bridge passes it on.
  async function handoff(req: IncomingMessage, res: ServerResponse) {
    const device = requireDevice(req)
    const body = await readJson(req)
    if (!isObject(body)) throw new HttpError(400, 'Send { hob, device, capability, method, args }')
    markDeviceActive(db, device.id)
    try {
      const { device: target, value } = await devices.handoff(device.id, {
        hob: body.hob,
        device: body.device,
        capability: body.capability,
        method: body.method,
        args: body.args,
      })
      json(res, 200, { ok: true, device: target, value })
    } catch (err) {
      if (!(err instanceof DeviceError)) throw err
      json(res, 200, { ok: false, error: { code: err.code, message: err.message } })
    }
  }

  // Which hob wrote a Hobwork tag, so the app can hand a scan of it to that
  // hob's open page.
  async function nfcLookup(req: IncomingMessage, res: ServerResponse) {
    requireDevice(req)
    const body = await readJson(req)
    const found = isObject(body) && typeof body.url === 'string' ? devices.nfcTagHob(body.url) : undefined
    if (!found) throw new HttpError(404, 'This is not a tag of this Hobwork host')
    json(res, 200, found)
  }

  // The web bridge's native.liveActivities from a hob page in the app. A start
  // is for this device, which starts the activity itself from the answer;
  // update and end reach every device that shows it.
  async function liveActivity(req: IncomingMessage, res: ServerResponse) {
    const device = requireDevice(req)
    const body = await readJson(req)
    if (!isObject(body) || typeof body.hob !== 'string' || !['start', 'update', 'end'].includes(body.op as string)) {
      throw new HttpError(400, 'Send { hob, op: "start" | "update" | "end", id?, args }')
    }
    markDeviceActive(db, device.id)
    const la = devices.liveActivities
    try {
      if (body.op === 'start') json(res, 200, la.startHere(body.hob, device, body.args))
      else if (body.op === 'update') json(res, 200, await la.update(body.hob, body.id, body.args, 'all'))
      else json(res, 200, await la.end(body.hob, body.id, body.args, 'all'))
    } catch (err) {
      if (!(err instanceof DeviceError)) throw err
      json(res, err.code === 'unsupported' ? 403 : 400, { error: err.message, code: err.code })
    }
  }

  // Hobs with a widget or intents, for the widget's and Shortcuts' pickers.
  async function hobs(req: IncomingMessage, res: ServerResponse) {
    requireDevice(req)
    json(res, 200, { hobs: await devices.surfaces.hobs() })
  }

  async function widget(req: IncomingMessage, res: ServerResponse, hob: string) {
    const device = requireDevice(req)
    touchDevice(db, device.id)
    try {
      json(res, 200, await devices.surfaces.widget(device, hob))
    } catch (err) {
      if (err instanceof SurfaceError) json(res, err.status, { error: err.message, code: err.code })
      else throw err
    }
  }

  // Answers 200 either way, so Shortcuts can say what went wrong.
  async function intent(req: IncomingMessage, res: ServerResponse) {
    const device = requireDevice(req)
    const body = await readJson(req)
    if (!isObject(body)) throw new HttpError(400, 'Send { hob, intent, parameters? }')
    markDeviceActive(db, device.id)
    try {
      json(res, 200, { ok: true, ...(await devices.surfaces.runIntent(device, { hob: body.hob, intent: body.intent, parameters: body.parameters })) })
    } catch (err) {
      if (!(err instanceof SurfaceError)) throw err
      json(res, 200, { ok: false, error: { code: err.code, message: err.message } })
    }
  }

  type Handle = (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const endpoints: Record<string, Record<string, Handle>> = {
    [TOKEN_PATH]: { POST: token },
    [WEB_SESSION_PATH]: { POST: webSession },
    [PUSH_PATH]: { PUT: push },
    [EVENTS_PATH]: { POST: events },
    [RESULTS_PATH]: { POST: results },
    [SELF_PATH]: { GET: describeSelf, DELETE: removeSelf },
    [HANDOFF_PATH]: { POST: handoff },
    [NFC_LOOKUP_PATH]: { POST: nfcLookup },
    [LIVE_ACTIVITIES_PATH]: { POST: liveActivity },
    [HOBS_PATH]: { GET: hobs },
    [INTENTS_PATH]: { POST: intent },
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
    const widgetMatch = WIDGET_PATH.exec(pathname)
    if (widgetMatch && req.method === 'GET') {
      try {
        await widget(req, res, widgetMatch[1]!)
      } catch (err) {
        if (err instanceof HttpError) json(res, err.status, { error: err.message })
        else throw err
      }
      return true
    }
    const endpoint = endpoints[pathname]
    if (!endpoint) return false
    const handle = endpoint[req.method ?? '']
    if (!handle) {
      res.writeHead(405, { allow: Object.keys(endpoint).join(', ') }).end()
      return true
    }
    try {
      await handle(req, res)
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
