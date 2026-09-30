import { HA_MAX_RETRIES, type HaServiceResult, type HaState, type HomeAssistant } from '../homeassistant.ts'
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

const READ_RETRIES = 2
const RETRYABLE = new Set(['timeout', 'connection_lost', 'not_connected', 'host_error'])

export function createHaClient(send: HaSend, { retryDelayMs = 500 } = {}): HomeAssistant {
  async function call<T>(request: DistributiveOmit<HaRequest, 'invocation'>, retries = 0): Promise<T> {
    retries = Math.min(Math.max(0, Math.floor(retries)), HA_MAX_RETRIES)
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await send(request)
        if (!response.ok) throw new HomeAssistantError(response.error.code, response.error.message)
        return response.result as T
      } catch (err) {
        if (attempt >= retries || !(err instanceof HomeAssistantError) || !RETRYABLE.has(err.code)) throw err
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt))
      }
    }
  }

  return {
    callService: (domain, service, data, target, options) =>
      call<HaServiceResult>(
        {
          action: 'callService',
          domain,
          service,
          data,
          target,
          returnResponse: options?.returnResponse,
          timeoutMs: options?.timeoutMs,
        },
        options?.retries,
      ),
    getState: async (entityId, options) =>
      (await call<HaState | null>({ action: 'getState', entityId, timeoutMs: options?.timeoutMs }, READ_RETRIES)) ??
      undefined,
    getStates: (filter, options) => call<HaState[]>({ action: 'getStates', filter, timeoutMs: options?.timeoutMs }, READ_RETRIES),
    fireEvent: async (eventType, data, options) => {
      await call({ action: 'fireEvent', eventType, data, timeoutMs: options?.timeoutMs })
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
