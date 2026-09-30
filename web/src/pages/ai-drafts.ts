import type { AiLimits, ModelChoice } from '../api.ts'

export const inputClass =
  'mt-2 min-h-10 w-full rounded-md border border-border bg-surface-raised px-3 text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none disabled:opacity-60'

export function money(dollars: number): string {
  if (dollars > 0 && dollars < 0.01) return 'under $0.01'
  return `$${dollars.toFixed(2)}`
}

export function count(n: number): string {
  return n.toLocaleString()
}

// inherit: the level above picks (Settings for a hob, the server for Settings).
// off: no decision model, so the chat model answers decisions too.
export type ModelDraft = { mode: 'inherit' | 'set' | 'off'; text: string }

export function modelDraft(value: string | false | null): ModelDraft {
  if (value === false) return { mode: 'off', text: '' }
  return value === null ? { mode: 'inherit', text: '' } : { mode: 'set', text: value }
}

export function draftModel(draft: ModelDraft): string | false | null {
  if (draft.mode === 'off') return false
  return draft.mode === 'inherit' ? null : draft.text.trim()
}

export type ModelsDraft = { model: ModelDraft; decisionModel: ModelDraft; embeddingModel: ModelDraft }

export function modelsDraft(settings: ModelChoice): ModelsDraft {
  return {
    model: modelDraft(settings.model),
    decisionModel: modelDraft(settings.decisionModel),
    embeddingModel: modelDraft(settings.embeddingModel),
  }
}

export function draftModels(draft: ModelsDraft): ModelChoice {
  const text = (field: ModelDraft) => (field.mode === 'inherit' ? null : field.text.trim())
  return { model: text(draft.model), decisionModel: draftModel(draft.decisionModel), embeddingModel: text(draft.embeddingModel) }
}

type LimitField = Exclude<keyof AiLimits, 'throttle'>
export type LimitsDraft = { throttle: boolean } & Record<LimitField, string>

export const LIMIT_FIELDS: { field: LimitField; label: string; money: boolean }[] = [
  { field: 'requestsPerMinute', label: 'Requests per minute', money: false },
  { field: 'requestsPerHour', label: 'Requests per hour', money: false },
  { field: 'costPerDay', label: 'Spending per day (US$)', money: true },
  { field: 'costPerMonth', label: 'Spending per 30 days (US$)', money: true },
]

export function limitsDraft(limits: AiLimits): LimitsDraft {
  const text = (value: number | null) => (value === null ? '' : String(value))
  return {
    throttle: limits.throttle,
    requestsPerMinute: text(limits.requestsPerMinute),
    requestsPerHour: text(limits.requestsPerHour),
    costPerDay: text(limits.costPerDay),
    costPerMonth: text(limits.costPerMonth),
  }
}

export function draftLimits(draft: LimitsDraft): AiLimits {
  const value = (text: string) => (text.trim() === '' ? null : Number(text))
  return {
    throttle: draft.throttle,
    requestsPerMinute: value(draft.requestsPerMinute),
    requestsPerHour: value(draft.requestsPerHour),
    costPerDay: value(draft.costPerDay),
    costPerMonth: value(draft.costPerMonth),
  }
}

export function describeLimits(limits: AiLimits): string {
  if (!limits.throttle) return 'No request or spending limits'
  const parts = [
    limits.requestsPerMinute !== null && `${count(limits.requestsPerMinute)} requests per minute`,
    limits.requestsPerHour !== null && `${count(limits.requestsPerHour)} per hour`,
    limits.costPerDay !== null && `${money(limits.costPerDay)} per day`,
    limits.costPerMonth !== null && `${money(limits.costPerMonth)} per 30 days`,
  ].filter(Boolean)
  return parts.length ? `At most ${parts.join(', ')}` : 'No request or spending limits'
}
