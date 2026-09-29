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

// Calls go through the Hobwork host, which holds the Home Assistant connection.
// Errors from Home Assistant (unknown service, invalid data, not connected)
// throw a HomeAssistantError with its code and message.
export interface HomeAssistant {
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: HaServiceTarget,
    options?: { returnResponse?: boolean },
  ): Promise<HaServiceResult>
  // Undefined when the entity does not exist.
  getState(entityId: string): Promise<HaState | undefined>
  getStates(filter?: HaStatesFilter): Promise<HaState[]>
  // Fires an event on the Home Assistant event bus, for HA automations to react to.
  fireEvent(eventType: string, data?: Record<string, unknown>): Promise<void>
}
