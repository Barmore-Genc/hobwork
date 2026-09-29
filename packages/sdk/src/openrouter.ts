import type { Context } from './index.ts'

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
export const OPENROUTER_SECRET = 'OPENROUTER_API_KEY'

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | Record<string, unknown>

export type ChatMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: string | ChatContentPart[] | null
  name?: string
  tool_call_id?: string
  tool_calls?: unknown[]
}

// The OpenRouter chat completions request. Fields not listed here (tools,
// reasoning, provider routing, ...) are passed through as they are.
export type ChatRequest = {
  // e.g. "openai/gpt-5-mini", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash".
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
  [key: string]: unknown
}

export type ChatCompletion = {
  id: string
  model: string
  choices: {
    index: number
    finish_reason: string | null
    message: ChatMessage & { content: string | null; reasoning?: string | null }
  }[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost?: number }
  [key: string]: unknown
}

export type ChatResult = {
  // The first choice's text, '' when the model returned none (e.g. only tool calls).
  text: string
  completion: ChatCompletion
}

type SchemaIssue = { readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> }
type SchemaResult<T> = { readonly value: T; readonly issues?: undefined } | { readonly issues: ReadonlyArray<SchemaIssue> }

// A schema that validates values and converts to JSON Schema (Standard Schema
// with Standard JSON Schema). Zod 4 schemas are one.
export type JsonSchemaType<T> = {
  readonly '~standard': {
    readonly validate: (value: unknown) => SchemaResult<T> | Promise<SchemaResult<T>>
    readonly jsonSchema: { readonly output: (options: { target: string }) => Record<string, unknown> }
    readonly types?: { readonly output: T } | undefined
  }
}

export type JsonRequest<T> = ChatRequest & {
  schema: JsonSchemaType<T>
  // Name of the schema sent to the model. Default: "response".
  schemaName?: string
  // Strict mode makes providers that support it follow the schema exactly, but
  // needs every property to be required (use `.nullable()` instead of `.optional()`).
  strict?: boolean
}

// `code` is OpenRouter's error code, or one of these:
// - `hobwork_model_not_allowed` (403): the hob may not use the model.
// - `hobwork_rate_limit` and `hobwork_spend_limit` (429): the hob reached a
//   limit people set in Hobwork. `metadata.retry_after_seconds` says when it may try again.
// - `timeout`, `aborted`: the call's timeout ran out or its signal aborted it.
// - `missing_secret`, `invalid_json`, `invalid_output`.
export class OpenRouterError extends Error {
  status?: number
  code?: string | number
  // OpenRouter's error metadata, e.g. `raw` and `provider_name` for provider errors.
  metadata?: Record<string, unknown>

  constructor(message: string, status?: number, code?: string | number, metadata?: Record<string, unknown>) {
    super(message)
    this.name = 'OpenRouterError'
    this.status = status
    this.code = code
    this.metadata = metadata
  }
}

export type OpenRouterOptions = {
  // Default: the OPENROUTER_API_KEY secret's placeholder from ctx.secrets.
  apiKey?: string
  // Milliseconds each call waits for OpenRouter's answer. Default: no limit
  // of its own, so only the invocation's timeout applies.
  timeout?: number
}

export type OpenRouterCallOptions = {
  // Milliseconds to wait for OpenRouter's answer. Default: the client's `timeout`.
  timeout?: number
  signal?: AbortSignal
}

export type OpenRouter = {
  chat(request: ChatRequest, options?: OpenRouterCallOptions): Promise<ChatResult>
  // Structured output: the reply as a value that passed the schema.
  json<T>(request: JsonRequest<T>, options?: OpenRouterCallOptions): Promise<T>
  // JSON mode without a schema: the reply parsed as JSON.
  json(request: ChatRequest, options?: OpenRouterCallOptions): Promise<unknown>
}

function parseJson(text: string): unknown {
  // Some models wrap JSON in a Markdown code fence even in JSON mode.
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text)
  try {
    return JSON.parse(fenced ? fenced[1]! : text)
  } catch {
    throw new OpenRouterError(`The model did not return valid JSON: ${text.slice(0, 500)}`, undefined, 'invalid_json')
  }
}

type ErrorBody = { message?: string; code?: string | number; metadata?: Record<string, unknown> }

function apiError(error: ErrorBody | undefined, httpStatus: number): OpenRouterError {
  const { metadata } = error ?? {}
  let message = error?.message ?? `OpenRouter answered HTTP ${httpStatus}`
  // Provider errors say only "Provider returned error"; the provider's own message is in metadata.raw.
  const raw = metadata?.raw
  if (raw) {
    const provider = typeof metadata.provider_name === 'string' ? ` (${metadata.provider_name})` : ''
    message += `${provider}: ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`
  }
  // An error that happens after OpenRouter started answering comes with HTTP 200 and its status as the code.
  const status = httpStatus === 200 && typeof error?.code === 'number' ? error.code : httpStatus
  return new OpenRouterError(message, status, error?.code, metadata)
}

function issuePath(issue: SchemaIssue): string {
  return (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.')
}

// Calls OpenRouter through ctx.fetch. The API key is the secret's placeholder,
// which Hobwork replaces on the way to openrouter.ai, so the secret must be
// allowed to go to that host.
export function openrouter(ctx: Pick<Context, 'fetch' | 'secrets'>, options: OpenRouterOptions = {}): OpenRouter {
  async function send(body: Record<string, unknown>, apiKey: string, call: OpenRouterCallOptions): Promise<{ res: Response; text: string }> {
    const timeout = call.timeout ?? options.timeout
    const timer = timeout === undefined ? undefined : AbortSignal.timeout(timeout)
    const signals = [call.signal, timer].filter((signal) => signal !== undefined)
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    try {
      const res = await ctx.fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      return { res, text: await res.text() }
    } catch (err) {
      if (timer?.aborted) throw new OpenRouterError(`OpenRouter did not answer within ${timeout} ms`, undefined, 'timeout')
      if (call.signal?.aborted) {
        throw Object.assign(new OpenRouterError('The OpenRouter call was aborted', undefined, 'aborted'), { cause: call.signal.reason })
      }
      throw err
    }
  }

  async function complete(body: Record<string, unknown>, call: OpenRouterCallOptions): Promise<ChatResult> {
    const apiKey = options.apiKey ?? ctx.secrets[OPENROUTER_SECRET]
    if (!apiKey) {
      throw new OpenRouterError(
        `The hob has no ${OPENROUTER_SECRET} secret. Assign an OpenRouter key to it as ${OPENROUTER_SECRET} with assign_secret, or ask the user to create one in Hobwork that may be sent to openrouter.ai`,
        undefined,
        'missing_secret',
      )
    }
    const { res, text } = await send(body, apiKey, call)
    let parsed: { error?: ErrorBody } & Partial<ChatCompletion>
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new OpenRouterError(`OpenRouter answered HTTP ${res.status}: ${text.slice(0, 500)}`, res.status)
    }
    if (!res.ok || parsed.error) {
      throw apiError(parsed.error, res.status)
    }
    const completion = parsed as ChatCompletion
    const content = completion.choices?.[0]?.message?.content
    return { text: typeof content === 'string' ? content : '', completion }
  }

  async function json(request: ChatRequest | JsonRequest<unknown>, call: OpenRouterCallOptions = {}): Promise<unknown> {
    if (!('schema' in request) || !request.schema) {
      const { text } = await complete({ ...request, response_format: { type: 'json_object' } }, call)
      return parseJson(text)
    }
    const { schema, schemaName, strict, ...rest } = request as JsonRequest<unknown>
    const { $schema: _, ...jsonSchema } = schema['~standard'].jsonSchema.output({ target: 'draft-07' })
    const provider = typeof rest.provider === 'object' && rest.provider !== null ? rest.provider : {}
    const { text } = await complete({
      ...rest,
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName ?? 'response', strict: strict ?? true, schema: jsonSchema },
      },
      // Only route to providers that support structured output. Without this,
      // models that do not support it ignore the schema and answer in prose.
      provider: { require_parameters: true, ...provider },
    }, call).catch((err: unknown) => {
      if (err instanceof OpenRouterError && err.status === 404 && err.metadata?.failed_routing_step === 'Filter by Parameters') {
        err.message += `. ${request.model} may not support structured output: pick a model that lists structured_outputs in its supported parameters, or call json() without a schema for JSON mode`
      }
      throw err
    })
    const result = await schema['~standard'].validate(parseJson(text))
    if (result.issues) {
      const issues = result.issues.map((issue) => `${issuePath(issue) || '(root)'}: ${issue.message}`).join('; ')
      throw new OpenRouterError(`The model's reply does not match the schema: ${issues}`, undefined, 'invalid_output')
    }
    return result.value
  }

  return {
    chat: (request, call = {}) => complete(request, call),
    json: json as OpenRouter['json'],
  }
}
