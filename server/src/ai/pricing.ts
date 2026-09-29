import type { Usage } from './usage.ts'

// US dollars per token.
export type ModelPrice = { prompt: number; completion: number; request: number }
export type PriceList = Map<string, ModelPrice>

const MODELS_URL = 'https://openrouter.ai/api/v1/models'
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

export function parsePriceList(body: unknown): PriceList {
  const list: PriceList = new Map()
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined
  if (!Array.isArray(data)) return list
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, pricing } = entry as { id?: unknown; pricing?: Record<string, unknown> }
    const prompt = price(pricing?.prompt)
    const completion = price(pricing?.completion)
    if (typeof id !== 'string' || prompt === undefined || completion === undefined) continue
    list.set(id.toLowerCase(), { prompt, completion, request: price(pricing?.request) ?? 0 })
  }
  return list
}

export type PriceSource = () => Promise<PriceList>

// OpenRouter's public model list, kept for an hour. A failed refresh keeps the
// old list and is retried after a minute.
export function openRouterPrices(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): PriceSource {
  let list: PriceList = new Map()
  let nextRefresh = 0
  let pending: Promise<PriceList> | undefined
  return () => {
    if (now() < nextRefresh) return Promise.resolve(list)
    pending ??= (async () => {
      try {
        const response = await fetchImpl(MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const fresh = parsePriceList(await response.json())
        if (fresh.size === 0) throw new Error('no models in the list')
        list = fresh
        nextRefresh = now() + REFRESH_MS
      } catch (err) {
        console.error('Could not fetch OpenRouter model prices', err)
        nextRefresh = now() + RETRY_MS
      }
      return list
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
}

// About four characters per token; only used when the answer has no counts.
const guessTokens = (text: string) => Math.ceil(text.length / 4)

// The cost of a request whose answer had no cost. Token counts come from the
// answer, or are guessed from the sizes of the request and answer when it has
// none. Answers with errors are not billed.
export function estimateUsage(
  usage: Usage | undefined,
  request: { models: string[]; text: string },
  response: { status: number; text: string },
  prices: PriceList,
): Usage | undefined {
  if (usage?.cost !== undefined) return usage
  if (response.status < 200 || response.status >= 300) return usage
  const promptTokens = usage?.promptTokens ?? guessTokens(request.text)
  const completionTokens = usage?.completionTokens ?? guessTokens(response.text)
  const candidates = [usage?.model, ...request.models]
  const found = candidates.map((model) => (model === undefined ? undefined : prices.get(model.toLowerCase()))).find((p) => p !== undefined)
  const rate = found ?? FALLBACK_PRICE
  const cost = promptTokens * rate.prompt + completionTokens * rate.completion + rate.request
  return { ...usage, promptTokens, completionTokens, cost }
}
