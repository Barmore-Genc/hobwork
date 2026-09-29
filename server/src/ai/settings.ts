import type { DatabaseSync } from 'node:sqlite'

export type AiLimits = {
  // Off: only the model list applies.
  throttle: boolean
  requestsPerMinute: number | null
  requestsPerHour: number | null
  // US dollars in the last 24 hours and the last 30 days.
  costPerDay: number | null
  costPerMonth: number | null
}

export const DEFAULT_LIMITS: AiLimits = {
  throttle: true,
  requestsPerMinute: 20,
  requestsPerHour: 200,
  costPerDay: 1,
  costPerMonth: 10,
}

type Updated = { updatedAt: string | null; updatedBy: string | null }

// models: null allows every model, [] none.
export type HostAiSettings = Updated & { models: string[] | null; limits: AiLimits }
// null: the host-wide setting applies.
export type ProjectAiSettings = Updated & { models: string[] | null; limits: AiLimits | null }

export type EffectiveAiSettings = {
  hostModels: string[] | null
  projectModels: string[] | null
  limits: AiLimits
}

export class AiSettingsError extends Error {}

const MAX_MODELS = 200
const MAX_MODEL_CHARS = 200
const MAX_REQUESTS = 1_000_000
const MAX_COST = 100_000

export function parseModels(value: unknown): string[] | null {
  if (value === null) return null
  if (!Array.isArray(value)) throw new AiSettingsError('models must be a list of model names, or null for any model')
  const models = [...new Set(value.map((entry) => (typeof entry === 'string' ? entry.trim() : entry)))]
  for (const model of models) {
    if (typeof model !== 'string' || !model) throw new AiSettingsError('Each model must be a name like openai/gpt-5-mini')
    if (model.length > MAX_MODEL_CHARS || /\s/.test(model)) throw new AiSettingsError(`"${model.slice(0, 40)}" is not a model name`)
  }
  if (models.length > MAX_MODELS) throw new AiSettingsError(`List at most ${MAX_MODELS} models`)
  return models as string[]
}

function limit(body: Record<string, unknown>, name: keyof AiLimits, max: number, whole: boolean): number | null {
  const value = body[name]
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max || (whole && !Number.isInteger(value))) {
    throw new AiSettingsError(`${name} must be ${whole ? 'a whole number' : 'a number'} above 0 and at most ${max}, or null for no limit`)
  }
  return value
}

export function parseLimits(value: unknown): AiLimits {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AiSettingsError('limits must be an object')
  const body = value as Record<string, unknown>
  if (typeof body.throttle !== 'boolean') throw new AiSettingsError('throttle must be true or false')
  return {
    throttle: body.throttle,
    requestsPerMinute: limit(body, 'requestsPerMinute', MAX_REQUESTS, true),
    requestsPerHour: limit(body, 'requestsPerHour', MAX_REQUESTS, true),
    costPerDay: limit(body, 'costPerDay', MAX_COST, false),
    costPerMonth: limit(body, 'costPerMonth', MAX_COST, false),
  }
}

function json<T>(value: unknown): T | null {
  return typeof value === 'string' ? (JSON.parse(value) as T) : null
}

function updated(row: Record<string, unknown> | undefined): Updated {
  return { updatedAt: (row?.updated_at as string | undefined) ?? null, updatedBy: (row?.updated_by as string | null | undefined) ?? null }
}

export function hostAiSettings(db: DatabaseSync): HostAiSettings {
  const row = db
    .prepare(
      `SELECT s.models, s.limits, s.updated_at, u.name AS updated_by
       FROM ai_settings s LEFT JOIN users u ON u.id = s.updated_by_user_id WHERE s.id = 1`,
    )
    .get()
  return {
    models: json<string[]>(row?.models),
    // Stored limits get defaults for fields added later.
    limits: { ...DEFAULT_LIMITS, ...json<AiLimits>(row?.limits) },
    ...updated(row),
  }
}

export function saveHostAiSettings(db: DatabaseSync, settings: { models: string[] | null; limits: AiLimits }, userId: number | null) {
  db.prepare(
    `INSERT INTO ai_settings (id, models, limits, updated_by_user_id, updated_at)
     VALUES (1, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (id) DO UPDATE SET models = excluded.models, limits = excluded.limits,
       updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`,
  ).run(settings.models && JSON.stringify(settings.models), JSON.stringify(settings.limits), userId)
}

export function projectAiSettings(db: DatabaseSync, projectId: number): ProjectAiSettings {
  const row = db
    .prepare(
      `SELECT s.models, s.limits, s.updated_at, u.name AS updated_by
       FROM project_ai_settings s LEFT JOIN users u ON u.id = s.updated_by_user_id WHERE s.project_id = ?`,
    )
    .get(projectId)
  const limits = json<AiLimits>(row?.limits)
  return { models: json<string[]>(row?.models), limits: limits && { ...DEFAULT_LIMITS, ...limits }, ...updated(row) }
}

export function saveProjectAiSettings(
  db: DatabaseSync,
  projectId: number,
  settings: { models: string[] | null; limits: AiLimits | null },
  userId: number | null,
) {
  if (settings.models === null && settings.limits === null) {
    db.prepare('DELETE FROM project_ai_settings WHERE project_id = ?').run(projectId)
    return
  }
  db.prepare(
    `INSERT INTO project_ai_settings (project_id, models, limits, updated_by_user_id, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (project_id) DO UPDATE SET models = excluded.models, limits = excluded.limits,
       updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`,
  ).run(projectId, settings.models && JSON.stringify(settings.models), settings.limits && JSON.stringify(settings.limits), userId)
}

export function effectiveAiSettings(db: DatabaseSync, projectId: number): EffectiveAiSettings {
  const host = hostAiSettings(db)
  const project = projectAiSettings(db, projectId)
  return { hostModels: host.models, projectModels: project.models, limits: project.limits ?? host.limits }
}

// `*` matches any run of characters, so `openai/*` allows every OpenAI model
// and `openai/gpt-5-mini*` also its variants like `:free`.
export function modelMatches(model: string, patterns: string[]): boolean {
  const name = model.toLowerCase()
  return patterns.some((pattern) => {
    const escaped = pattern
      .toLowerCase()
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp(`^${escaped}$`).test(name)
  })
}

export function modelAllowed(model: string, settings: Pick<EffectiveAiSettings, 'hostModels' | 'projectModels'>): boolean {
  return [settings.hostModels, settings.projectModels].every((list) => list === null || modelMatches(model, list))
}
