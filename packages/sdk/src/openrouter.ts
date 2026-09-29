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

export class OpenRouterError extends Error {
  status?: number
  code?: string | number

  constructor(message: string, status?: number, code?: string | number) {
    super(message)
    this.name = 'OpenRouterError'
    this.status = status
    this.code = code
  }
}

export type OpenRouterOptions = {
  // Default: the OPENROUTER_API_KEY secret's placeholder from ctx.secrets.
  apiKey?: string
}

export type OpenRouter = {
  chat(request: ChatRequest): Promise<ChatResult>
  // Structured output: the reply as a value that passed the schema.
  json<T>(request: JsonRequest<T>): Promise<T>
  // JSON mode without a schema: the reply parsed as JSON.
  json(request: ChatRequest): Promise<unknown>
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

function issuePath(issue: SchemaIssue): string {
  return (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.')
}

// Calls OpenRouter through ctx.fetch. The API key is the secret's placeholder,
// which Hobwork replaces on the way to openrouter.ai, so the secret must be
// bound to that host.
export function openrouter(ctx: Pick<Context, 'fetch' | 'secrets'>, options: OpenRouterOptions = {}): OpenRouter {
  async function complete(body: Record<string, unknown>): Promise<ChatResult> {
    const apiKey = options.apiKey ?? ctx.secrets[OPENROUTER_SECRET]
    if (!apiKey) {
      throw new OpenRouterError(
        `The ${OPENROUTER_SECRET} secret does not exist. Ask the user to add it in Hobwork, bound to openrouter.ai`,
        undefined,
        'missing_secret',
      )
    }
    const res = await ctx.fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: { error?: { message?: string; code?: string | number } } & Partial<ChatCompletion>
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new OpenRouterError(`OpenRouter answered HTTP ${res.status}: ${text.slice(0, 500)}`, res.status)
    }
    if (!res.ok || parsed.error) {
      throw new OpenRouterError(parsed.error?.message ?? `OpenRouter answered HTTP ${res.status}`, res.status, parsed.error?.code)
    }
    const completion = parsed as ChatCompletion
    const content = completion.choices?.[0]?.message?.content
    return { text: typeof content === 'string' ? content : '', completion }
  }

  async function json(request: ChatRequest | JsonRequest<unknown>): Promise<unknown> {
    if (!('schema' in request) || !request.schema) {
      const { text } = await complete({ ...request, response_format: { type: 'json_object' } })
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
      // Only route to providers that support structured output.
      provider: { require_parameters: true, ...provider },
    })
    const result = await schema['~standard'].validate(parseJson(text))
    if (result.issues) {
      const issues = result.issues.map((issue) => `${issuePath(issue) || '(root)'}: ${issue.message}`).join('; ')
      throw new OpenRouterError(`The model's reply does not match the schema: ${issues}`, undefined, 'invalid_output')
    }
    return result.value
  }

  return {
    chat: (request) => complete(request),
    json: json as OpenRouter['json'],
  }
}
