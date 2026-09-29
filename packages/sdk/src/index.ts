export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type Logger = Record<LogLevel, (...args: unknown[]) => void>

export type InvocationKind = 'route' | 'webhook' | 'cron' | 'trigger'

export type Invocation = {
  id: number
  kind: InvocationKind
  // The route key from hobwork.json ("GET /spools/:id"), or the cron, webhook or trigger name.
  name: string
  // True when started with the invoke tool rather than by a request, schedule or event.
  manual: boolean
}

export type Context = {
  invocation: Invocation
  // The HTTP request, for routes and webhooks.
  request?: Request
  // Values of `:name` segments in the route path.
  params: Record<string, string>
  // The event for triggers (Home Assistant trigger variables), or what a manual
  // invocation passed.
  payload?: unknown
  // Outgoing HTTP. Only hosts listed in `egress` in hobwork.json are reachable.
  fetch: typeof fetch
  // Log lines are stored with the invocation. console.log and friends work too.
  log: Logger
}

export type RequestContext = Context & { request: Request }

// A route or webhook handler may return a Response, which is sent as is, or any
// other value, which is sent as JSON (undefined sends 204 No Content).
export type Handler<C extends Context = Context> = (ctx: C) => unknown

export type RequestHandler = Handler<RequestContext>
