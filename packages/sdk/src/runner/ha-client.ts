import type { HaServiceResult, HaState, HomeAssistant } from '../homeassistant.ts'
import { internalPost } from './internal-fetch.ts'
import type { HaRequest, HaResponse } from './protocol.ts'

// The runner and the handler bundle each have their own copy of this class, so
// instanceof checks a brand instead of the prototype chain.
const BRAND = Symbol.for('hobwork.HomeAssistantError')

export class HomeAssistantError extends Error {
  // Home Assistant's error code (e.g. "service_not_found", "invalid_format"), or
  // Hobwork's: "not_configured", "not_connected", "timeout", "read_only".
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'HomeAssistantError'
    this.code = code
    Object.defineProperty(this, BRAND, { value: true })
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[BRAND] === true
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type HaSend = (request: DistributiveOmit<HaRequest, 'invocation'>) => Promise<HaResponse>

export function createHaClient(send: HaSend): HomeAssistant {
  async function call<T>(request: DistributiveOmit<HaRequest, 'invocation'>): Promise<T> {
    const response = await send(request)
    if (!response.ok) throw new HomeAssistantError(response.error.code, response.error.message)
    return response.result as T
  }

  return {
    callService: (domain, service, data, target, options) =>
      call<HaServiceResult>({ action: 'callService', domain, service, data, target, returnResponse: options?.returnResponse }),
    getState: async (entityId) => (await call<HaState | null>({ action: 'getState', entityId })) ?? undefined,
    getStates: (filter) => call<HaState[]>({ action: 'getStates', filter }),
    fireEvent: async (eventType, data) => {
      await call({ action: 'fireEvent', eventType, data })
    },
  }
}

export function httpHaSender(baseUrl: string, invocation?: () => number | undefined): HaSend {
  return async (request) => {
    const res = await internalPost(baseUrl, '/v1/ha', JSON.stringify({ ...request, invocation: invocation?.() }))
    const body = (await res.json().catch(() => undefined)) as HaResponse | { error?: string } | undefined
    if (body && 'ok' in body) return body
    throw new HomeAssistantError(
      'host_error',
      `The host could not reach Home Assistant: HTTP ${res.status}${body?.error ? ` ${body.error}` : ''}`,
    )
  }
}
