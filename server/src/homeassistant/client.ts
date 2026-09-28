import type { HomeAssistantConnection } from '../config.ts'

export type Logger = Pick<Console, 'info' | 'warn' | 'error'>

// A trigger in Home Assistant automation syntax, or a list of them.
export type HaTrigger = Record<string, unknown> | Record<string, unknown>[]

export type TriggerVariables = { trigger?: Record<string, unknown>; [key: string]: unknown }

export type HaContext = { id: string; parent_id: string | null; user_id: string | null }

export type TriggerCallback = (variables: TriggerVariables, context: HaContext | undefined) => void | Promise<void>

export type Unsubscribe = () => Promise<void>

export type HaState = {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
  last_changed: string
  last_updated: string
  context?: HaContext
}

export type HaDevice = {
  id: string
  name: string | null
  name_by_user: string | null
  manufacturer: string | null
  model: string | null
  area_id: string | null
  identifiers: [string, string][]
  disabled_by: string | null
  [key: string]: unknown
}

export type HaEntityRegistryEntry = {
  entity_id: string
  id: string
  name: string | null
  original_name: string | null
  platform: string
  device_id: string | null
  area_id: string | null
  disabled_by: string | null
  hidden_by: string | null
  [key: string]: unknown
}

export type HaArea = { area_id: string; name: string; floor_id?: string | null; [key: string]: unknown }

export type HaServiceField = {
  name?: string
  description?: string
  required?: boolean
  example?: unknown
  selector?: Record<string, unknown>
  fields?: Record<string, HaServiceField>
}

export type HaService = {
  name?: string
  description?: string
  fields: Record<string, HaServiceField>
  target?: Record<string, unknown>
  response?: { optional: boolean }
}

export type HaServices = Record<string, Record<string, HaService>>

export type HaServiceTarget = {
  entity_id?: string | string[]
  device_id?: string | string[]
  area_id?: string | string[]
  floor_id?: string | string[]
  label_id?: string | string[]
}

export type CallServiceResult = { context: HaContext; response?: unknown }

export type HomeAssistantStatus = 'idle' | 'unconfigured' | 'connecting' | 'connected' | 'disconnected' | 'stopped'

export class HomeAssistantError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HomeAssistantError'
    this.code = code
  }
}

export type HomeAssistantOptions = {
  // A function rather than a value so the connection settings can move from env
  // vars to a DB-backed setting; call reload() after they change.
  connection: () => HomeAssistantConnection | undefined
  logger?: Logger
  requestTimeoutMs?: number
  reconnectDelayMs?: { initial: number; max: number }
  // HA does not notice a half-open TCP connection on our side, and neither do
  // we without traffic, so the connection is pinged.
  pingIntervalMs?: number
}

export type HomeAssistant = {
  readonly status: HomeAssistantStatus
  readonly configured: boolean
  start(): void
  stop(): void
  reload(): void
  waitUntilConnected(timeoutMs?: number): Promise<void>
  request<T = unknown>(message: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: HaServiceTarget,
    options?: { returnResponse?: boolean },
  ): Promise<CallServiceResult>
  getState(entityId: string): Promise<HaState | undefined>
  getStates(): Promise<HaState[]>
  listDevices(): Promise<HaDevice[]>
  listEntities(): Promise<HaEntityRegistryEntry[]>
  listAreas(): Promise<HaArea[]>
  listServices(): Promise<HaServices>
  listDeviceTriggers(deviceId: string): Promise<Record<string, unknown>[]>
  // Resolves once HA accepted the trigger, and rejects if HA refuses it. While
  // disconnected it resolves right away and the trigger is subscribed on
  // connect; later refusals go to onError. Every subscription is renewed after
  // a reconnect.
  subscribeTrigger(
    trigger: HaTrigger,
    onFire: TriggerCallback,
    options?: { onError?: (err: Error) => void },
  ): Promise<Unsubscribe>
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

type Subscription = {
  trigger: HaTrigger
  onFire: TriggerCallback
  onError?: (err: Error) => void
  haId?: number
}

type Waiter = { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }

type HaMessage = {
  id?: number
  type: string
  success?: boolean
  result?: unknown
  error?: { code: string; message: string }
  event?: { variables?: TriggerVariables; context?: HaContext }
  message?: string
  ha_version?: string
}

const CONNECTION_LOST = 'connection_lost'

export function webSocketUrl(url: string): string {
  const u = new URL(url)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = `${u.pathname.replace(/\/$/, '')}/api/websocket`
  u.search = ''
  u.hash = ''
  return u.toString()
}

export function createHomeAssistant(options: HomeAssistantOptions): HomeAssistant {
  const logger = options.logger ?? console
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  const { initial: initialDelay, max: maxDelay } = options.reconnectDelayMs ?? { initial: 1000, max: 60_000 }
  const pingIntervalMs = options.pingIntervalMs ?? 30_000

  let status: HomeAssistantStatus = 'idle'
  let socket: WebSocket | undefined
  let nextId = 1
  let attempt = 0
  let lastError: string | undefined
  let downSince: Date | undefined
  let reconnectTimer: NodeJS.Timeout | undefined
  let pingTimer: NodeJS.Timeout | undefined
  const pending = new Map<number, Pending>()
  const subscriptions = new Set<Subscription>()
  const byHaId = new Map<number, Subscription>()
  const waiters = new Set<Waiter>()

  function notConnectedError(): HomeAssistantError {
    if (status === 'unconfigured' || (status === 'idle' && !options.connection())) {
      return new HomeAssistantError(
        'not_configured',
        'Home Assistant is not configured on this Hobwork host (HOBWORK_HA_URL and HOBWORK_HA_TOKEN are not set)',
      )
    }
    if (status === 'stopped') return new HomeAssistantError('stopped', 'The Home Assistant client was stopped')
    return new HomeAssistantError(
      'not_connected',
      `Home Assistant is not connected${lastError ? ` (${lastError})` : ''}. Hobwork keeps retrying in the background`,
    )
  }

  function rejectWaiters(err: Error) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    waiters.clear()
  }

  function connect() {
    reconnectTimer = undefined
    const connection = options.connection()
    if (!connection) {
      status = 'unconfigured'
      rejectWaiters(notConnectedError())
      return
    }
    status = 'connecting'
    let ws: WebSocket
    try {
      ws = new WebSocket(webSocketUrl(connection.url))
    } catch (err) {
      failed(`cannot open WebSocket: ${(err as Error).message}`)
      return
    }
    socket = ws
    ws.addEventListener('message', (event) => {
      if (socket !== ws) return
      let data: HaMessage | HaMessage[]
      try {
        data = JSON.parse(String(event.data))
      } catch {
        logger.warn('Home Assistant sent a message that is not JSON')
        return
      }
      for (const message of Array.isArray(data) ? data : [data]) handleMessage(ws, connection, message)
    })
    ws.addEventListener('close', (event) => {
      if (socket !== ws) return
      failed(`connection closed (code ${event.code}${event.reason ? `, ${event.reason}` : ''})`)
    })
    // A close event always follows an error event, and that is where the
    // connection is torn down.
    ws.addEventListener('error', () => {})
  }

  function handleMessage(ws: WebSocket, connection: HomeAssistantConnection, message: HaMessage) {
    switch (message.type) {
      case 'auth_required':
        ws.send(JSON.stringify({ type: 'auth', access_token: connection.token }))
        return
      case 'auth_ok':
        connected(message.ha_version)
        return
      case 'auth_invalid':
        logger.error(`Home Assistant rejected the access token: ${message.message ?? 'auth_invalid'}`)
        // Retrying quickly will not fix a bad token; wait the longest delay.
        attempt = Number.POSITIVE_INFINITY
        failed('access token rejected')
        return
      case 'result':
      case 'pong': {
        const entry = message.id === undefined ? undefined : pending.get(message.id)
        if (!entry) return
        pending.delete(message.id!)
        clearTimeout(entry.timer)
        if (message.type === 'pong' || message.success) entry.resolve(message.result)
        else {
          entry.reject(
            new HomeAssistantError(message.error?.code ?? 'unknown_error', message.error?.message ?? 'Request failed'),
          )
        }
        return
      }
      case 'event': {
        const subscription = message.id === undefined ? undefined : byHaId.get(message.id)
        if (!subscription || !message.event) return
        fire(subscription, message.event.variables ?? {}, message.event.context)
        return
      }
    }
  }

  function fire(subscription: Subscription, variables: TriggerVariables, context: HaContext | undefined) {
    const report = (err: unknown) => logger.error('Home Assistant trigger callback failed', err)
    try {
      const result = subscription.onFire(variables, context)
      if (result instanceof Promise) result.catch(report)
    } catch (err) {
      report(err)
    }
  }

  function connected(version: string | undefined) {
    status = 'connected'
    attempt = 0
    lastError = undefined
    if (downSince) {
      const seconds = Math.round((Date.now() - downSince.getTime()) / 1000)
      logger.info(`Reconnected to Home Assistant after ${seconds}s`)
      if (subscriptions.size > 0) {
        logger.warn(
          `Home Assistant triggers that fired between ${downSince.toISOString()} and ${new Date().toISOString()} were missed (${subscriptions.size} trigger subscriptions affected)`,
        )
      }
      downSince = undefined
    } else {
      logger.info(`Connected to Home Assistant${version ? ` ${version}` : ''}`)
    }
    pingTimer = setInterval(() => {
      const ws = socket
      request({ type: 'ping' }).catch((err: Error) => {
        if (socket !== ws || !ws || isConnectionLost(err)) return
        logger.warn(`Home Assistant did not answer a ping (${err.message}), reconnecting`)
        failed('ping timed out')
      })
    }, pingIntervalMs)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    waiters.clear()
    for (const subscription of subscriptions) {
      activate(subscription, true).catch(() => {})
    }
  }

  function teardown(reason: string, code: string) {
    const ws = socket
    socket = undefined
    if (ws) {
      try {
        ws.close()
      } catch {}
    }
    clearInterval(pingTimer)
    pingTimer = undefined
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new HomeAssistantError(code, `Home Assistant ${reason}`))
    }
    pending.clear()
    byHaId.clear()
    for (const subscription of subscriptions) subscription.haId = undefined
  }

  function failed(reason: string) {
    const wasConnected = status === 'connected'
    teardown(`connection lost: ${reason}`, CONNECTION_LOST)
    if (status === 'stopped') return
    status = 'disconnected'
    const firstFailure = lastError === undefined
    lastError = reason
    downSince ??= new Date()
    const delay = Math.min(maxDelay, initialDelay * 2 ** attempt)
    attempt++
    if (wasConnected) {
      logger.warn(
        `Lost the Home Assistant connection (${reason}), reconnecting.${subscriptions.size > 0 ? ` ${subscriptions.size} trigger subscriptions are inactive until then, and triggers that fire meanwhile are lost.` : ''}`,
      )
    } else if (firstFailure) {
      logger.warn(`Cannot connect to Home Assistant (${reason}), retrying in the background`)
    }
    reconnectTimer = setTimeout(connect, delay)
  }

  function send<T>(id: number, message: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const ws = socket
    if (status !== 'connected' || !ws) return Promise.reject(notConnectedError())
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new HomeAssistantError('timeout', `Home Assistant did not answer "${String(message.type)}" within ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ ...message, id }))
    })
  }

  async function waitUntilConnected(timeoutMs = requestTimeoutMs): Promise<void> {
    if (status === 'connected') return
    if (status === 'idle' || status === 'unconfigured' || status === 'stopped') throw notConnectedError()
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter)
          reject(notConnectedError())
        }, timeoutMs),
      }
      waiters.add(waiter)
    })
  }

  async function request<T>(message: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? requestTimeoutMs
    const started = Date.now()
    await waitUntilConnected(timeoutMs)
    return send<T>(nextId++, message, Math.max(1, timeoutMs - (Date.now() - started)))
  }

  function isConnectionLost(err: unknown): boolean {
    return err instanceof HomeAssistantError && err.code === CONNECTION_LOST
  }

  async function activate(subscription: Subscription, report: boolean): Promise<void> {
    const id = nextId++
    subscription.haId = id
    byHaId.set(id, subscription)
    try {
      await send(id, { type: 'subscribe_trigger', trigger: subscription.trigger }, requestTimeoutMs)
    } catch (err) {
      byHaId.delete(id)
      if (subscription.haId === id) subscription.haId = undefined
      if (err instanceof HomeAssistantError && err.code === 'timeout') {
        // HA may have set it up after all; make sure it does not linger there.
        request({ type: 'unsubscribe_events', subscription: id }).catch(() => {})
      }
      if (report && !isConnectionLost(err) && subscriptions.has(subscription)) {
        if (subscription.onError) subscription.onError(err as Error)
        else logger.error(`Home Assistant refused a trigger subscription: ${(err as Error).message}`)
      }
      throw err
    }
  }

  async function subscribeTrigger(
    trigger: HaTrigger,
    onFire: TriggerCallback,
    opts: { onError?: (err: Error) => void } = {},
  ): Promise<Unsubscribe> {
    if (status === 'idle' || status === 'unconfigured' || status === 'stopped') throw notConnectedError()
    const subscription: Subscription = { trigger, onFire, onError: opts.onError }
    subscriptions.add(subscription)
    const unsubscribe = async () => {
      if (!subscriptions.delete(subscription)) return
      const haId = subscription.haId
      subscription.haId = undefined
      if (haId === undefined) return
      byHaId.delete(haId)
      if (status !== 'connected') return
      try {
        await send(nextId++, { type: 'unsubscribe_events', subscription: haId }, requestTimeoutMs)
      } catch (err) {
        if (!isConnectionLost(err)) {
          logger.warn(`Could not remove a Home Assistant trigger subscription: ${(err as Error).message}`)
        }
      }
    }
    if (status === 'connected') {
      try {
        await activate(subscription, false)
      } catch (err) {
        if (!isConnectionLost(err)) {
          subscriptions.delete(subscription)
          throw err
        }
      }
    }
    return unsubscribe
  }

  return {
    get status() {
      return status
    },
    get configured() {
      return options.connection() !== undefined
    },
    start() {
      if (status !== 'idle') return
      connect()
    },
    stop() {
      if (status === 'stopped') return
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      status = 'stopped'
      teardown('client stopped', 'stopped')
      subscriptions.clear()
      rejectWaiters(notConnectedError())
    },
    reload() {
      if (status === 'stopped') return
      clearTimeout(reconnectTimer)
      teardown('connection settings changed', CONNECTION_LOST)
      attempt = 0
      lastError = undefined
      if (subscriptions.size > 0) downSince ??= new Date()
      connect()
    },
    waitUntilConnected,
    request,
    async callService(domain, service, data, target, opts = {}) {
      return request<CallServiceResult>({
        type: 'call_service',
        domain,
        service,
        ...(data ? { service_data: data } : {}),
        ...(target ? { target } : {}),
        ...(opts.returnResponse ? { return_response: true } : {}),
      })
    },
    async getState(entityId) {
      return (await request<HaState[]>({ type: 'get_states' })).find((s) => s.entity_id === entityId)
    },
    getStates: () => request<HaState[]>({ type: 'get_states' }),
    listDevices: () => request<HaDevice[]>({ type: 'config/device_registry/list' }),
    listEntities: () => request<HaEntityRegistryEntry[]>({ type: 'config/entity_registry/list' }),
    listAreas: () => request<HaArea[]>({ type: 'config/area_registry/list' }),
    listServices: () => request<HaServices>({ type: 'get_services' }),
    listDeviceTriggers: (deviceId) =>
      request<Record<string, unknown>[]>({ type: 'device_automation/trigger/list', device_id: deviceId }),
    subscribeTrigger,
  }
}
