import type { AiLimits } from '../api.ts'

export const inputClass =
  'mt-2 min-h-10 w-full rounded-md border border-border bg-surface-raised px-3 text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none disabled:opacity-60'

export function money(dollars: number): string {
  if (dollars > 0 && dollars < 0.01) return 'under $0.01'
  return `$${dollars.toFixed(2)}`
}

export function count(n: number): string {
  return n.toLocaleString()
}

export type ModelsDraft = { any: boolean; text: string }

export function modelsDraft(models: string[] | null): ModelsDraft {
  return { any: models === null, text: (models ?? []).join('\n') }
}

export function draftModels(draft: ModelsDraft): string[] | null {
  if (draft.any) return null
  return draft.text
    .split(/[\s,]+/)
    .map((model) => model.trim())
    .filter(Boolean)
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
