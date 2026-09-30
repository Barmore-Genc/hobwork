import type { DatabaseSync } from 'node:sqlite'
import { modelProblem, type CatalogSource } from './catalog.ts'

export type AiLimits = {
  // Off: no request or spend limits.
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

export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash'
export const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13'
export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small'

// The models hobs get. decisionModel null: decision models are off, and
// check and pick run on `model` instead.
export type AiModels = { model: string; decisionModel: string | null; embeddingModel: string }

export const DEFAULT_MODELS: AiModels = {
  model: DEFAULT_MODEL,
  decisionModel: DEFAULT_DECISION_MODEL,
  embeddingModel: DEFAULT_EMBEDDING_MODEL,
}

// null: the level above applies (a hob's settings the host's, the host's its
// environment). decisionModel false: off.
export type ModelOverrides = { model: string | null; decisionModel: string | false | null; embeddingModel: string | null }

// A person in the web UI or an agent over MCP. null in tests and scripts.
export type Changer = { userId: number } | { agentId: number } | null

type Updated = { updatedAt: string | null; updatedBy: string | null }

export type HostAiSettings = Updated & ModelOverrides & { limits: AiLimits }
// limits null: the host-wide limits apply.
export type ProjectAiSettings = Updated & ModelOverrides & { limits: AiLimits | null }

export type EffectiveAiSettings = { models: AiModels; limits: AiLimits }

export class AiSettingsError extends Error {}

const MAX_MODEL_CHARS = 200
const MAX_REQUESTS = 1_000_000
const MAX_COST = 100_000

function modelName(value: unknown, name: string): string {
  const model = typeof value === 'string' ? value.trim() : value
  if (typeof model !== 'string' || !model) throw new AiSettingsError(`${name} must be an OpenRouter model ID like ${DEFAULT_MODEL}`)
  if (model.length > MAX_MODEL_CHARS || /\s/.test(model)) throw new AiSettingsError(`"${model.slice(0, 40)}" is not a model ID`)
  return model
}

export function parseModel(value: unknown, name = 'model'): string | null {
  return value === null || value === undefined ? null : modelName(value, name)
}

export function parseDecisionModel(value: unknown): string | false | null {
  if (value === null || value === undefined || value === false) return value ?? null
  return modelName(value, 'decisionModel')
}

export function parseModelOverrides(body: Record<string, unknown>): ModelOverrides {
  return {
    model: parseModel(body.model),
    decisionModel: parseDecisionModel(body.decisionModel),
    embeddingModel: parseModel(body.embeddingModel, 'embeddingModel'),
  }
}

// The host's model defaults, and OpenRouter's model list to check new models
// against. Without a catalog any model ID is accepted.
export type AiConfig = { models: AiModels; catalog?: CatalogSource }

export async function checkModels(config: AiConfig, overrides: Partial<ModelOverrides>): Promise<void> {
  if (!config.catalog || (!overrides.model && !overrides.decisionModel && !overrides.embeddingModel)) return
  const catalog = await config.catalog()
  const problem =
    (overrides.model && modelProblem(catalog, overrides.model, 'chat')) ||
    (overrides.decisionModel && modelProblem(catalog, overrides.decisionModel, 'decisions')) ||
    (overrides.embeddingModel && modelProblem(catalog, overrides.embeddingModel, 'embeddings'))
  if (problem) throw new AiSettingsError(problem)
}

export function applyOverrides(base: AiModels, overrides: ModelOverrides): AiModels {
  const { decisionModel } = overrides
  return {
    model: overrides.model ?? base.model,
    decisionModel: decisionModel === false ? null : (decisionModel ?? base.decisionModel),
    embeddingModel: overrides.embeddingModel ?? base.embeddingModel,
  }
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

function overridesOf(row: Record<string, unknown> | undefined): ModelOverrides {
  const decision = row?.decision_model
  return {
    model: typeof row?.model === 'string' ? row.model : null,
    decisionModel: decision === '' ? false : typeof decision === 'string' ? decision : null,
    embeddingModel: typeof row?.embedding_model === 'string' ? row.embedding_model : null,
  }
}

const storedDecision = (value: string | false | null) => (value === false ? '' : value)

function updated(row: Record<string, unknown> | undefined): Updated {
  return { updatedAt: (row?.updated_at as string | undefined) ?? null, updatedBy: (row?.updated_by as string | null | undefined) ?? null }
}

function changerIds(by: Changer): [number | null, number | null] {
  return [by && 'userId' in by ? by.userId : null, by && 'agentId' in by ? by.agentId : null]
}

const UPDATED_BY = `COALESCE(u.name, a.name) AS updated_by
  FROM %TABLE% s LEFT JOIN users u ON u.id = s.updated_by_user_id LEFT JOIN agents a ON a.id = s.updated_by_agent_id`

export function hostAiSettings(db: DatabaseSync): HostAiSettings {
  const row = db
    .prepare(`SELECT s.model, s.decision_model, s.embedding_model, s.limits, s.updated_at, ${UPDATED_BY.replace('%TABLE%', 'ai_settings')} WHERE s.id = 1`)
    .get()
  return {
    ...overridesOf(row),
    // Stored limits get defaults for fields added later.
    limits: { ...DEFAULT_LIMITS, ...json<AiLimits>(row?.limits) },
    ...updated(row),
  }
}

export function saveHostAiSettings(db: DatabaseSync, settings: ModelOverrides & { limits: AiLimits }, by: Changer) {
  db.prepare(
    `INSERT INTO ai_settings (id, model, decision_model, embedding_model, limits, updated_by_user_id, updated_by_agent_id, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (id) DO UPDATE SET model = excluded.model, decision_model = excluded.decision_model,
       embedding_model = excluded.embedding_model, limits = excluded.limits,
       updated_by_user_id = excluded.updated_by_user_id, updated_by_agent_id = excluded.updated_by_agent_id,
       updated_at = excluded.updated_at`,
  ).run(
    settings.model,
    storedDecision(settings.decisionModel),
    settings.embeddingModel,
    JSON.stringify(settings.limits),
    ...changerIds(by),
  )
}

// Changes only the given fields, for agents that set a model without seeing the limits.
export function updateHostModels(db: DatabaseSync, changes: Partial<ModelOverrides>, by: Changer) {
  saveHostAiSettings(db, withChanges(hostAiSettings(db), changes), by)
}

function withChanges<T extends ModelOverrides>(current: T, changes: Partial<ModelOverrides>): T {
  return {
    ...current,
    ...(changes.model !== undefined && { model: changes.model }),
    ...(changes.decisionModel !== undefined && { decisionModel: changes.decisionModel }),
    ...(changes.embeddingModel !== undefined && { embeddingModel: changes.embeddingModel }),
  }
}

export function projectAiSettings(db: DatabaseSync, projectId: number): ProjectAiSettings {
  const row = db
    .prepare(
      `SELECT s.model, s.decision_model, s.embedding_model, s.limits, s.updated_at, ${UPDATED_BY.replace('%TABLE%', 'project_ai_settings')}
       WHERE s.project_id = ?`,
    )
    .get(projectId)
  const limits = json<AiLimits>(row?.limits)
  return { ...overridesOf(row), limits: limits && { ...DEFAULT_LIMITS, ...limits }, ...updated(row) }
}

export function saveProjectAiSettings(
  db: DatabaseSync,
  projectId: number,
  settings: ModelOverrides & { limits: AiLimits | null },
  by: Changer,
) {
  if (settings.model === null && settings.decisionModel === null && settings.embeddingModel === null && settings.limits === null) {
    db.prepare('DELETE FROM project_ai_settings WHERE project_id = ?').run(projectId)
    return
  }
  db.prepare(
    `INSERT INTO project_ai_settings (project_id, model, decision_model, embedding_model, limits, updated_by_user_id, updated_by_agent_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (project_id) DO UPDATE SET model = excluded.model, decision_model = excluded.decision_model,
       embedding_model = excluded.embedding_model,
       limits = excluded.limits, updated_by_user_id = excluded.updated_by_user_id,
       updated_by_agent_id = excluded.updated_by_agent_id, updated_at = excluded.updated_at`,
  ).run(
    projectId,
    settings.model,
    storedDecision(settings.decisionModel),
    settings.embeddingModel,
    settings.limits && JSON.stringify(settings.limits),
    ...changerIds(by),
  )
}

export function updateProjectModels(db: DatabaseSync, projectId: number, changes: Partial<ModelOverrides>, by: Changer) {
  saveProjectAiSettings(db, projectId, withChanges(projectAiSettings(db, projectId), changes), by)
}

// `defaults` are the host's environment: HOBWORK_AI_MODEL, HOBWORK_AI_DECISION_MODEL and HOBWORK_AI_EMBEDDING_MODEL.
export function hostModels(db: DatabaseSync, defaults: AiModels): AiModels {
  return applyOverrides(defaults, hostAiSettings(db))
}

export function effectiveAiSettings(db: DatabaseSync, projectId: number, defaults: AiModels): EffectiveAiSettings {
  const host = hostAiSettings(db)
  const project = projectAiSettings(db, projectId)
  return { models: applyOverrides(applyOverrides(defaults, host), project), limits: project.limits ?? host.limits }
}
