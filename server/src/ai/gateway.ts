import type { Host } from '../host.ts'
import { getProject } from '../projects.ts'
import { appendLog } from '../runtime/logs.ts'
import type { Interceptor } from '../sandbox/sandbox.ts'
import { estimateUsage, openRouterPrices, type PriceSource } from './pricing.ts'
import { effectiveAiSettings, modelAllowed, type EffectiveAiSettings } from './settings.ts'
import {
  finishAiRequest,
  limitHit,
  MINUTE_MS,
  startAiRequest,
  type AiSource,
  type LimitHit,
  type RefusalKind,
  type Usage,
} from './usage.ts'

// Every request a project VM sends to these hosts goes through the gateway.
export const OPENROUTER_HOSTS = ['openrouter.ai', '*.openrouter.ai']

// Codes of the errors Hobwork answers with instead of OpenRouter. The SDK
// reports them as OpenRouterError.code.
export const AI_ERROR_CODES = {
  model: 'hobwork_model_not_allowed',
  rate: 'hobwork_rate_limit',
  spend: 'hobwork_spend_limit',
  path: 'hobwork_path_not_allowed',
  https: 'hobwork_https_required',
  port: 'hobwork_port_not_allowed',
} as const

const WHERE_TO_CHANGE = "People change this on the hob's AI page in Hobwork"
// Endpoints that report usage and cost only when asked to. The gateway overrides whatever
// the guest sent, since the spend limits rely on the reported cost.
const USAGE_PATHS = /\/(chat\/)?completions$/

// Paths hobs use. Everything else on OpenRouter (API keys, credits, account
// settings) is refused, since the API key is filled in for all of it.
const API_PREFIX = '/api/v1'
const METERED_PATHS = new Set(['/chat/completions', '/completions', '/messages', '/responses', '/embeddings'])
const READ_PATHS = /^\/(models(\/[^/]+){0,3}|key|generation)$/

function pathAllowed(method: string, pathname: string): boolean {
  if (!pathname.startsWith(`${API_PREFIX}/`)) return false
  const path = pathname.slice(API_PREFIX.length)
  if (method === 'POST') return METERED_PATHS.has(path)
  if (method === 'GET' || method === 'HEAD') return READ_PATHS.test(path)
  return false
}

type Refusal = { kind: RefusalKind | 'path' | 'https' | 'port'; status: number; message: string; metadata: Record<string, unknown>; retryAfterMs?: number }

// Refusals that are recorded with the request, since the request was one a hob was allowed to make.
type CountedRefusal = Refusal & { kind: RefusalKind }

export type AiScope = { source: AiSource; branch?: string }

export type AiGateway = {
  // Undefined when the project does not exist.
  interceptor(project: string, scope: AiScope): Interceptor | undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// OpenRouter falls back through `models` when `model` fails, so all of them must be allowed.
function requestedModels(body: Record<string, unknown> | undefined): string[] {
  if (!body) return []
  const models = [body.model, ...(Array.isArray(body.models) ? body.models : [])]
  return [...new Set(models.filter((m): m is string => typeof m === 'string' && m !== ''))]
}

function allowedText(settings: EffectiveAiSettings): string {
  const list = settings.projectModels ?? settings.hostModels ?? []
  return list.length ? `It may use ${list.join(', ')}` : 'It may not use any model'
}

function modelRefusal(models: string[], settings: EffectiveAiSettings): CountedRefusal | undefined {
  if (settings.hostModels === null && settings.projectModels === null) return undefined
  const metadata = { allowed_models: settings.projectModels ?? settings.hostModels }
  if (!models.length) {
    return {
      kind: 'model',
      status: 403,
      message: `Hobwork only passes on requests that name their model, since this hob may only use some models. ${allowedText(settings)}.`,
      metadata,
    }
  }
  const refused = models.find((model) => !modelAllowed(model, settings))
  if (!refused) return undefined
  return {
    kind: 'model',
    status: 403,
    message: `Hobwork does not let this project use ${refused}. ${allowedText(settings)}. ${WHERE_TO_CHANGE}.`,
    metadata: { ...metadata, model: refused },
  }
}

function duration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 90) return `${minutes} minutes`
  const hours = Math.ceil(minutes / 60)
  if (hours < 36) return `${hours} hours`
  return `${Math.ceil(hours / 24)} days`
}

const WINDOWS: Record<LimitHit['limit'], string> = {
  requestsPerMinute: 'minute',
  requestsPerHour: 'hour',
  costPerDay: '24 hours',
  costPerMonth: '30 days',
}

const dollars = (value: number) => `$${value.toFixed(2)}`

function limitRefusal(hit: LimitHit): CountedRefusal {
  const window = WINDOWS[hit.limit]
  const what =
    hit.kind === 'rate'
      ? `This hob sent ${hit.used} requests to OpenRouter in the last ${window}, and Hobwork allows ${hit.max}`
      : `This hob spent ${dollars(hit.used)} on OpenRouter in the last ${window}, and Hobwork stops it at ${dollars(hit.max)}`
  return {
    kind: hit.kind,
    status: 429,
    message: `${what}. Try again in ${duration(hit.retryAfterMs)}. ${WHERE_TO_CHANGE}.`,
    metadata: {
      limit: hit.limit,
      max: hit.max,
      used: hit.kind === 'spend' ? Math.round(hit.used * 1e6) / 1e6 : hit.used,
      retry_after_seconds: Math.max(1, Math.ceil(hit.retryAfterMs / 1000)),
    },
    retryAfterMs: hit.retryAfterMs,
  }
}

// OpenRouter's error format, so the SDK and other clients read it like OpenRouter's own.
function refusalResponse(refusal: Refusal): Response {
  const headers: Record<string, string> = {}
  if (refusal.retryAfterMs !== undefined) headers['retry-after'] = String(Math.max(1, Math.ceil(refusal.retryAfterMs / 1000)))
  return Response.json(
    { error: { code: AI_ERROR_CODES[refusal.kind], message: refusal.message, metadata: refusal.metadata } },
    { status: refusal.status, headers },
  )
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function usageOf(value: unknown): Usage | undefined {
  if (!isObject(value)) return undefined
  // The Responses API streams its usage inside the final `response`.
  const usage = isObject(value.usage) ? value.usage : isObject(value.response) && isObject(value.response.usage) ? value.response.usage : undefined
  if (!usage) return undefined
  const inner = isObject(value.response) ? value.response : undefined
  const model = typeof value.model === 'string' ? value.model : typeof inner?.model === 'string' ? inner.model : undefined
  return {
    model,
    promptTokens: numberOr(usage.prompt_tokens) ?? numberOr(usage.input_tokens),
    completionTokens: numberOr(usage.completion_tokens) ?? numberOr(usage.output_tokens),
    cost: numberOr(usage.cost),
  }
}

// Plain JSON, or server-sent events whose last chunk with usage has the totals.
export function parseUsage(text: string, contentType: string | null): Usage | undefined {
  if (contentType?.includes('text/event-stream') || /^(data|event|:)/.test(text.trimStart())) {
    let found: Usage | undefined
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        found = usageOf(JSON.parse(data)) ?? found
      } catch {
        // Not JSON; OpenRouter only sends comments and JSON chunks.
      }
    }
    return found
  }
  try {
    return usageOf(JSON.parse(text))
  } catch {
    return undefined
  }
}

// Limits and records what project VMs send to OpenRouter. It runs on the host
// in the VM's egress path, so project code cannot get around it: the API key
// is only filled in for these hosts, and only after the checks here.
export function createAiGateway(host: Host, options: { now?: () => number; prices?: PriceSource } = {}): AiGateway {
  const now = options.now ?? Date.now
  const prices = options.prices ?? openRouterPrices()
  // A handler that keeps retrying would fill the log with the same line.
  const lastLogged = new Map<string, number>()

  function logRefusal(project: string, scope: AiScope, refusal: Refusal) {
    const key = `${project}\n${scope.source}\n${scope.branch ?? ''}\n${refusal.kind}`
    const time = now()
    if ((lastLogged.get(key) ?? -Infinity) > time - MINUTE_MS) return
    lastLogged.set(key, time)
    const where = scope.source === 'workspace' ? `Workspace ${scope.branch}: ` : ''
    try {
      appendLog(host, {
        project,
        branch: scope.source === 'workspace' ? undefined : scope.branch,
        source: 'runtime',
        level: 'warn',
        event: 'ai-limit',
        message: `${where}${refusal.message}`,
      })
    } catch (err) {
      console.error(`Could not log an AI limit for ${project}`, err)
    }
  }

  return {
    interceptor(project, scope) {
      const record = getProject(host, project)
      if (!record) return undefined
      const projectId = record.id
      return {
        hosts: OPENROUTER_HOSTS,
        async handle(request, upstream) {
          const url = new URL(request.url)
          const wrong =
            url.protocol !== 'https:'
              ? { kind: 'https' as const, message: 'Hobwork only lets hobs reach OpenRouter over https. Use https://openrouter.ai/api/v1.' }
              : url.port !== ''
                ? { kind: 'port' as const, message: `Hobwork only lets hobs reach OpenRouter on port 443, not ${url.port}. Use https://openrouter.ai/api/v1.` }
                : !pathAllowed(request.method, url.pathname)
                ? { kind: 'path' as const, message: `Hobwork does not let hobs call ${request.method} ${url.pathname} on OpenRouter. Hobs can use the chat, completions, messages, responses and embeddings endpoints and read model lists.` }
                : undefined
          if (wrong) {
            const refusal = { ...wrong, status: 403, metadata: {} }
            logRefusal(project, scope, refusal)
            return refusalResponse(refusal)
          }
          // Model lists, key info and the like cost nothing.
          if (request.method !== 'POST') return upstream(request)
          const text = await request.text()
          let body: Record<string, unknown> | undefined
          try {
            const parsed: unknown = JSON.parse(text)
            if (isObject(parsed)) body = parsed
          } catch {
            // Sent on as it is; only the model list needs a body to check.
          }
          const models = requestedModels(body)
          const settings = effectiveAiSettings(host.db, projectId)
          const started = now()
          const hit = limitHit(host.db, projectId, settings.limits, started)
          const refusal = modelRefusal(models, settings) ?? (hit && limitRefusal(hit))
          const id = startAiRequest(host.db, {
            projectId,
            branch: scope.branch,
            source: scope.source,
            path: url.pathname,
            model: models[0] ?? null,
            refused: refusal && { kind: refusal.kind, status: refusal.status },
            now: started,
          })
          if (refusal) {
            logRefusal(project, scope, refusal)
            return refusalResponse(refusal)
          }

          const forward = body && USAGE_PATHS.test(url.pathname)
            ? JSON.stringify({ ...body, usage: { include: true } })
            : text
          const headers = new Headers(request.headers)
          headers.delete('content-length')
          let response: Response
          let responseText: string
          try {
            response = await upstream(new Request(request.url, { method: 'POST', headers, body: forward }))
            responseText = await response.text()
          } catch (err) {
            finishAiRequest(host.db, id, 502, undefined, now())
            throw err
          }
          const reported = parseUsage(responseText, response.headers.get('content-type'))
          const billable = reported?.cost === undefined && response.status >= 200 && response.status < 300
          const usage = estimateUsage(reported, { models, text }, { status: response.status, text: responseText }, billable ? await prices() : new Map())
          finishAiRequest(host.db, id, response.status, usage, now())
          const empty = [204, 205, 304].includes(response.status)
          return new Response(empty ? null : responseText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        },
      }
    },
  }
}
