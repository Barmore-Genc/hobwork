import { HA_MAX_TIMEOUT_MS } from '../../../packages/sdk/src/homeassistant.ts'
import type { HaRequest, HaResponse } from '../../../packages/sdk/src/runner/protocol.ts'
import { truncateMiddle } from '../mcp/output.ts'
import { HomeAssistantError, type HaState, type HomeAssistant } from './client.ts'
import { eventsAllow, isBlockedEvent, isBlockedService, servicesAllow, WHERE_TO_CHANGE } from './services.ts'

// Runtime VMs run deployed code and may change the home. Workspace VMs run
// tests and work in progress, so they only read states. Branch previews
// change the home only while a person allows it for that branch, which is
// checked on every call so turning it off takes effect right away.
export type HaAccess = 'full' | 'read' | { branch: string; allowed: () => boolean }

export type HaCallLog = {
  invocation?: number
  level: 'debug' | 'info' | 'warn'
  message: string
}

export type HaEndpointOptions = {
  ha?: HomeAssistant
  access: HaAccess
  // The services the hob may call and the events it may fire, read on every call. Without it none is allowed.
  services?: () => string[]
  log?: (entry: HaCallLog) => void
}

const NAME = /^[a-z0-9_]+$/
const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/
const MAX_LOGGED_JSON = 500

const STATUS_BY_CODE: Record<string, number> = {
  not_configured: 503,
  not_connected: 503,
  connection_lost: 503,
  stopped: 503,
  timeout: 504,
  read_only: 403,
  not_approved: 403,
  not_allowed: 403,
  bad_request: 400,
}

class BadRequest extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalObject(value: unknown, what: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isObject(value)) throw new BadRequest(`${what} must be an object`)
  return value
}

function name(value: unknown, what: string): string {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new BadRequest(`${what} must be lowercase letters, digits and underscores, got ${JSON.stringify(value)}`)
  }
  return value
}

function timeout(value: unknown): { timeoutMs?: number } {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > HA_MAX_TIMEOUT_MS) {
    throw new BadRequest(`timeoutMs must be a whole number of milliseconds from 1 to ${HA_MAX_TIMEOUT_MS}, got ${JSON.stringify(value)}`)
  }
  return { timeoutMs: value }
}

function json(value: unknown): string {
  return truncateMiddle(JSON.stringify(value), MAX_LOGGED_JSON)
}

function describe(request: HaRequest): string {
  switch (request.action) {
    case 'callService': {
      const parts = [`${request.domain}.${request.service}`]
      if (request.data && Object.keys(request.data).length) parts.push(json(request.data))
      if (request.target) parts.push(`target ${json(request.target)}`)
      return parts.join(' ')
    }
    case 'getState':
      return `get state of ${request.entityId}`
    case 'getStates':
      return `get states${request.filter ? ` ${json(request.filter)}` : ''}`
    case 'fireEvent':
      return `fire event ${request.eventType}${request.data ? ` ${json(request.data)}` : ''}`
  }
}

function filterStates(states: HaState[], filter: Record<string, unknown> | undefined): HaState[] {
  if (!filter) return states
  const { domain, entityIds } = filter
  if (domain !== undefined) name(domain, 'filter.domain')
  if (entityIds !== undefined && (!Array.isArray(entityIds) || entityIds.some((id) => typeof id !== 'string'))) {
    throw new BadRequest('filter.entityIds must be a list of entity IDs')
  }
  const ids = entityIds ? new Set(entityIds as string[]) : undefined
  return states.filter(
    (state) => (domain === undefined || state.entity_id.startsWith(`${domain as string}.`)) && (!ids || ids.has(state.entity_id)),
  )
}

async function run(request: HaRequest, options: HaEndpointOptions & { ha: HomeAssistant }): Promise<unknown> {
  const { ha, access } = options
  const opts = timeout(request.timeoutMs)
  switch (request.action) {
    case 'callService':
    case 'fireEvent':
      if (typeof access === 'object' && !access.allowed()) {
        throw new HomeAssistantError(
          'not_approved',
          `Branch "${access.branch}" may not control Home Assistant. Turn it on with the set_branch_home_assistant MCP tool, or ask the user to turn on "Let this branch control Home Assistant" for it on the hob page in Hobwork`,
        )
      }
      if (access === 'read') {
        throw new HomeAssistantError(
          'read_only',
          'Workspaces can only read Home Assistant states. Service calls and events run from deployed handlers; in tests, fake ctx.ha with createTestContext',
        )
      }
      if (request.action === 'fireEvent') {
        if (typeof request.eventType !== 'string' || !request.eventType || request.eventType.length > 255) {
          throw new BadRequest('eventType must be a non-empty string')
        }
        if (isBlockedEvent(request.eventType)) {
          throw new HomeAssistantError(
            'not_allowed',
            `Hobwork does not let any hob fire the Home Assistant event ${request.eventType}, because Home Assistant uses it for itself`,
          )
        }
        if (!eventsAllow(options.services?.() ?? [], request.eventType)) {
          throw new HomeAssistantError(
            'not_allowed',
            `This hob may not fire the Home Assistant event ${request.eventType}. ${WHERE_TO_CHANGE}`,
          )
        }
        return ha.fireEvent(request.eventType, optionalObject(request.data, 'data'), opts)
      }
      const domain = name(request.domain, 'domain')
      const service = name(request.service, 'service')
      if (isBlockedService(domain, service)) {
        throw new HomeAssistantError(
          'not_allowed',
          `Hobwork does not let any hob call the Home Assistant service ${domain}.${service}, because it changes Home Assistant itself`,
        )
      }
      if (!servicesAllow(options.services?.() ?? [], domain, service)) {
        throw new HomeAssistantError(
          'not_allowed',
          `This hob may not call the Home Assistant service ${domain}.${service}. ${WHERE_TO_CHANGE}`,
        )
      }
      return ha.callService(
        domain,
        service,
        optionalObject(request.data, 'data'),
        optionalObject(request.target, 'target'),
        { returnResponse: request.returnResponse === true, ...opts },
      )
    case 'getState':
      if (typeof request.entityId !== 'string' || !ENTITY_ID.test(request.entityId)) {
        throw new BadRequest(`entityId must look like "light.kitchen", got ${JSON.stringify(request.entityId)}`)
      }
      return (await ha.getState(request.entityId, opts)) ?? null
    case 'getStates':
      return filterStates(await ha.getStates(opts), optionalObject(request.filter, 'filter'))
    default:
      throw new BadRequest(`Unknown action ${JSON.stringify((request as { action?: unknown }).action)}`)
  }
}

function answer(response: HaResponse, status = 200): Response {
  return Response.json(response, { status })
}

function failure(code: string, message: string): Response {
  return answer({ ok: false, error: { code, message } }, STATUS_BY_CODE[code] ?? 502)
}

// Answers POST http://hobwork.internal/v1/ha for a VM. The HA token stays on
// the host; the VM only sends what to call. Errors from HA answer with HA's
// code and message, which the SDK throws as a HomeAssistantError.
export async function haResponse(body: string, options: HaEndpointOptions): Promise<Response> {
  let request: HaRequest
  try {
    request = JSON.parse(body) as HaRequest
  } catch {
    return failure('bad_request', 'Body must be JSON')
  }
  if (!isObject(request)) return failure('bad_request', 'Body must be an object')
  const invocation = typeof request.invocation === 'number' ? request.invocation : undefined
  const reads = request.action === 'getState' || request.action === 'getStates'
  const { ha } = options
  if (!ha?.configured) {
    return failure(
      'not_configured',
      'Home Assistant is not configured on this Hobwork host. Ask the user to connect it',
    )
  }
  try {
    const result = await run(request, { ...options, ha })
    options.log?.({ invocation, level: reads ? 'debug' : 'info', message: `Home Assistant: ${describe(request)}` })
    return answer({ ok: true, result })
  } catch (err) {
    if (err instanceof BadRequest) return failure('bad_request', err.message)
    const code = err instanceof HomeAssistantError ? err.code : 'unknown_error'
    const message = err instanceof Error ? err.message : String(err)
    if (code === 'not_approved' || code === 'not_allowed') {
      options.log?.({ invocation, level: 'warn', message: `Home Assistant: denied ${describe(request)}. ${message}` })
    } else if (code !== 'read_only') {
      options.log?.({ invocation, level: 'warn', message: `Home Assistant: ${describe(request)} failed: ${message}` })
    }
    return failure(code, message)
  }
}
