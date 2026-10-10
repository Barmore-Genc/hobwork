import type { Usage } from './usage.ts'

// US dollars per token.
export type ModelPrice = { prompt: number; completion: number; request: number }
// `outputs` has `text` for chat models, `decisions` for decision models and `embeddings` for embedding models.
// `inputs` has `image` for models that read images.
export type ModelInfo = ModelPrice & { outputs: string[]; inputs: string[]; canDisableReasoning: boolean }
export type Catalog = Map<string, ModelInfo>

// Decision and embedding models are only listed when asked for.
const MODELS_URLS = [
  'https://openrouter.ai/api/v1/models',
  'https://openrouter.ai/api/v1/models?output_modalities=decisions',
  'https://openrouter.ai/api/v1/models?output_modalities=embeddings',
]
const REFRESH_MS = 60 * 60_000
const RETRY_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000

// For models without a known price: dearer than nearly every model, so an
// estimate errs toward stopping a hob early.
export const FALLBACK_PRICE: ModelPrice = { prompt: 15 / 1e6, completion: 75 / 1e6, request: 0 }

function price(value: unknown): number | undefined {
  const number = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  // Routers such as openrouter/auto report -1.
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function modalities(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((m): m is string => typeof m === 'string') : []
}

// Keyed by lowercase ID and by the dated build (`canonical_slug`) answers name.
export function parseCatalog(...bodies: unknown[]): Catalog {
  const catalog: Catalog = new Map()
  for (const body of bodies) {
    const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) continue
      const { id, canonical_slug: slug, pricing, architecture, supported_parameters: parameters, reasoning } = entry as {
        id?: unknown
        canonical_slug?: unknown
        pricing?: Record<string, unknown>
        architecture?: { output_modalities?: unknown; input_modalities?: unknown }
        supported_parameters?: unknown
        reasoning?: { mandatory?: unknown }
      }
      if (typeof id !== 'string') continue
      const outputs = modalities(architecture?.output_modalities)
      // Unknown prices fall back to FALLBACK_PRICE when estimating.
      const info: ModelInfo = {
        prompt: price(pricing?.prompt) ?? FALLBACK_PRICE.prompt,
        completion: price(pricing?.completion) ?? FALLBACK_PRICE.completion,
        request: price(pricing?.request) ?? 0,
        outputs,
        inputs: modalities(architecture?.input_modalities),
        canDisableReasoning: Array.isArray(parameters) && parameters.includes('reasoning') && reasoning?.mandatory !== true,
      }
      catalog.set(id.toLowerCase(), info)
      if (typeof slug === 'string' && !catalog.has(slug.toLowerCase())) catalog.set(slug.toLowerCase(), info)
    }
  }
  return catalog
}

export type CatalogSource = () => Promise<Catalog>

// OpenRouter's public model lists, kept for an hour. A failed refresh keeps the
// old catalog and is retried after a minute.
export function openRouterCatalog(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): CatalogSource {
  let catalog: Catalog = new Map()
  let nextRefresh = 0
  let pending: Promise<Catalog> | undefined
  return () => {
    if (now() < nextRefresh) return Promise.resolve(catalog)
    pending ??= (async () => {
      try {
        const bodies = await Promise.all(
          MODELS_URLS.map(async (url) => {
            const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
            if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
            return (await response.json()) as unknown
          }),
        )
        const fresh = parseCatalog(...bodies)
        if (fresh.size === 0) throw new Error('no models in the list')
        catalog = fresh
        nextRefresh = now() + REFRESH_MS
      } catch (err) {
        console.error('Could not fetch the OpenRouter model list', err)
        nextRefresh = now() + RETRY_MS
      }
      return catalog
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
}

// Why OpenRouter cannot run `model` as a chat, decision, embedding or vision model, or undefined
// when it can. An empty catalog (not fetched yet, or OpenRouter unreachable)
// finds no problem, so a model can still be set while offline.
export function modelProblem(catalog: Catalog, model: string, kind: 'chat' | 'decisions' | 'embeddings' | 'vision'): string | undefined {
  if (catalog.size === 0) return undefined
  const info = catalog.get(model.toLowerCase())
  if (!info) return `OpenRouter has no model "${model}"`
  if (kind === 'decisions' && !info.outputs.includes('decisions')) return `${model} is not a decision model`
  if (kind === 'embeddings' && !info.outputs.includes('embeddings')) return `${model} is not an embedding model`
  if ((kind === 'chat' || kind === 'vision') && !info.outputs.includes('text')) return `${model} does not answer with text`
  if (kind === 'vision' && !info.inputs.includes('image')) return `${model} does not read images`
  return undefined
}

// About four characters per token; only used when the answer has no counts.
const guessTokens = (text: string) => Math.ceil(text.length / 4)

// The cost of a request whose answer had no cost. Token counts come from the
// answer, or are guessed from the sizes of the request and answer when it has
// none. Answers with errors are not billed.
export function estimateUsage(
  usage: Usage | undefined,
  request: { model: string; text: string },
  response: { status: number; text: string },
  catalog: Catalog,
): Usage | undefined {
  if (usage?.cost !== undefined) return usage
  if (response.status < 200 || response.status >= 300) return usage
  const promptTokens = usage?.promptTokens ?? guessTokens(request.text)
  const completionTokens = usage?.completionTokens ?? guessTokens(response.text)
  const candidates = [usage?.model, request.model]
  const found = candidates.map((model) => (model === undefined ? undefined : catalog.get(model.toLowerCase()))).find((p) => p !== undefined)
  const rate = found ?? FALLBACK_PRICE
  const cost = promptTokens * rate.prompt + completionTokens * rate.completion + rate.request
  return { ...usage, promptTokens, completionTokens, cost }
}
