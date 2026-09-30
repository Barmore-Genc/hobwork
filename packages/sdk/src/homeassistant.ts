export type HaContext = { id: string; parent_id: string | null; user_id: string | null }

export type HaState = {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
  last_changed: string
  last_updated: string
  context?: HaContext
}

// Entities, devices, areas, floors or labels a service acts on. Each takes one
// ID or a list.
export type HaServiceTarget = {
  entity_id?: string | string[]
  device_id?: string | string[]
  area_id?: string | string[]
  floor_id?: string | string[]
  label_id?: string | string[]
}

export type HaServiceResult = {
  context: HaContext
  // Only for services that return data (e.g. weather.get_forecasts), called with
  // `returnResponse: true`.
  response?: unknown
}

export type HaStatesFilter = {
  // "light" returns every light.* entity.
  domain?: string
  entityIds?: string[]
}

export const HA_DEFAULT_TIMEOUT_MS = 10_000
export const HA_MAX_TIMEOUT_MS = 60_000
export { HA_MAX_RETRIES } from './runner/protocol.ts'

export type HaCallOptions = {
  // How long the host waits for Home Assistant to answer, at most HA_MAX_TIMEOUT_MS.
  timeoutMs?: number
}

export type HaServiceOptions = HaCallOptions & {
  returnResponse?: boolean
  // Retries after a timeout or a lost connection. A service call that timed out
  // may still have run in Home Assistant, so only set this for services that
  // only read, like recorder.get_statistics or weather.get_forecasts.
  retries?: number
}

// Calls go through the Hobwork host, which holds the Home Assistant connection.
// Errors from Home Assistant (unknown service, invalid data, not connected)
// throw a HomeAssistantError with its code and message. getState and getStates
// retry twice after a timeout or a lost connection.
export interface HomeAssistant {
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: HaServiceTarget,
    options?: HaServiceOptions,
  ): Promise<HaServiceResult>
  // Undefined when the entity does not exist.
  getState(entityId: string, options?: HaCallOptions): Promise<HaState | undefined>
  getStates(filter?: HaStatesFilter, options?: HaCallOptions): Promise<HaState[]>
  // Fires an event on the Home Assistant event bus, for HA automations to react to.
  fireEvent(eventType: string, data?: Record<string, unknown>, options?: HaCallOptions): Promise<void>
}
