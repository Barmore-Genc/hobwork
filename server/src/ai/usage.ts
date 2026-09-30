import type { DatabaseSync } from 'node:sqlite'
import type { AiLimits } from './settings.ts'

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS
export const MONTH_MS = 30 * DAY_MS
// Longer than the longest window, so the UI can show a month.
const KEEP_MS = 90 * DAY_MS

export type AiSource = 'runtime' | 'preview' | 'workspace'
export type RefusalKind = 'rate' | 'spend'

// `model` is the one that answered, which fallbacks can make another than the requested.
export type Usage = { promptTokens?: number; completionTokens?: number; cost?: number; model?: string }

const iso = (ms: number) => new Date(ms).toISOString()

export function startAiRequest(
  db: DatabaseSync,
  entry: {
    projectId: number
    branch?: string
    source: AiSource
    path: string
    model: string | null
    refused?: { kind: RefusalKind; status: number }
    now: number
  },
): number {
  const { refused } = entry
  const row = db
    .prepare(
      `INSERT INTO ai_requests (project_id, branch, source, path, model, refused, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      entry.projectId,
      entry.branch ?? null,
      entry.source,
      entry.path,
      entry.model,
      refused?.kind ?? null,
      refused?.status ?? null,
      iso(entry.now),
      refused ? iso(entry.now) : null,
    )
  return Number(row!.id)
}

export function finishAiRequest(db: DatabaseSync, id: number, status: number, usage: Usage | undefined, now: number) {
  db.prepare(
    `UPDATE ai_requests SET status = ?, prompt_tokens = ?, completion_tokens = ?, cost = ?, finished_at = ? WHERE id = ?`,
  ).run(status, usage?.promptTokens ?? null, usage?.completionTokens ?? null, usage?.cost ?? null, iso(now), id)
}

export type LimitHit = {
  kind: 'rate' | 'spend'
  limit: 'requestsPerMinute' | 'requestsPerHour' | 'costPerDay' | 'costPerMonth'
  max: number
  used: number
  windowMs: number
  retryAfterMs: number
}

// The first limit the project is at. Requests Hobwork refused do not count,
// so a handler that keeps retrying is let through again once the window moves.
export function limitHit(db: DatabaseSync, projectId: number, limits: AiLimits, now: number): LimitHit | undefined {
  if (!limits.throttle) return undefined
  const requestWindows = [
    { limit: 'requestsPerMinute', max: limits.requestsPerMinute, windowMs: MINUTE_MS },
    { limit: 'requestsPerHour', max: limits.requestsPerHour, windowMs: HOUR_MS },
  ] as const
  for (const { limit, max, windowMs } of requestWindows) {
    if (max === null) continue
    const since = iso(now - windowMs)
    const used = Number(
      db
        .prepare('SELECT count(*) AS n FROM ai_requests WHERE project_id = ? AND refused IS NULL AND started_at > ?')
        .get(projectId, since)!.n,
    )
    if (used < max) continue
    // Once this one leaves the window, the project is below the limit again.
    const freeing = db
      .prepare(
        `SELECT started_at FROM ai_requests WHERE project_id = ? AND refused IS NULL AND started_at > ?
         ORDER BY started_at LIMIT 1 OFFSET ?`,
      )
      .get(projectId, since, used - max)
    const retryAfterMs = Date.parse(String(freeing!.started_at)) + windowMs - now
    return { kind: 'rate', limit, max, used, windowMs, retryAfterMs }
  }
  const spendWindows = [
    { limit: 'costPerDay', max: limits.costPerDay, windowMs: DAY_MS },
    { limit: 'costPerMonth', max: limits.costPerMonth, windowMs: MONTH_MS },
  ] as const
  for (const { limit, max, windowMs } of spendWindows) {
    if (max === null) continue
    const rows = db
      .prepare(
        `SELECT started_at, cost FROM ai_requests
         WHERE project_id = ? AND refused IS NULL AND cost > 0 AND started_at > ? ORDER BY started_at`,
      )
      .all(projectId, iso(now - windowMs))
    const used = rows.reduce((sum, row) => sum + Number(row.cost), 0)
    if (used < max) continue
    let left = used
    let retryAfterMs = windowMs
    for (const row of rows) {
      left -= Number(row.cost)
      if (left < max) {
        retryAfterMs = Date.parse(String(row.started_at)) + windowMs - now
        break
      }
    }
    return { kind: 'spend', limit, max, used, windowMs, retryAfterMs }
  }
  return undefined
}

export type UsageTotals = {
  requests: number
  refused: number
  promptTokens: number
  completionTokens: number
  cost: number
}

export type ProjectUsage = {
  lastMinute: number
  lastHour: number
  day: UsageTotals
  month: UsageTotals
  // The last 30 days by model, most expensive first.
  models: (UsageTotals & { model: string | null })[]
}

const TOTALS = `count(*) FILTER (WHERE refused IS NULL) AS requests,
  count(*) FILTER (WHERE refused IS NOT NULL) AS refused,
  coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
  coalesce(sum(completion_tokens), 0) AS completion_tokens,
  coalesce(sum(cost), 0) AS cost`

function totals(row: Record<string, unknown> | undefined): UsageTotals {
  return {
    requests: Number(row?.requests ?? 0),
    refused: Number(row?.refused ?? 0),
    promptTokens: Number(row?.prompt_tokens ?? 0),
    completionTokens: Number(row?.completion_tokens ?? 0),
    cost: Number(row?.cost ?? 0),
  }
}

export function projectUsage(db: DatabaseSync, projectId: number, now: number): ProjectUsage {
  const since = (ms: number) =>
    totals(db.prepare(`SELECT ${TOTALS} FROM ai_requests WHERE project_id = ? AND started_at > ?`).get(projectId, iso(now - ms)))
  const models = db
    .prepare(
      `SELECT model, ${TOTALS} FROM ai_requests WHERE project_id = ? AND started_at > ?
       GROUP BY model ORDER BY cost DESC, requests DESC`,
    )
    .all(projectId, iso(now - MONTH_MS))
    .map((row) => ({ model: (row.model as string | null) ?? null, ...totals(row) }))
  return {
    lastMinute: since(MINUTE_MS).requests,
    lastHour: since(HOUR_MS).requests,
    day: since(DAY_MS),
    month: since(MONTH_MS),
    models,
  }
}

// The last 30 days per project, most expensive first. Projects without requests are left out.
export function usageByProject(db: DatabaseSync, now: number): (UsageTotals & { project: string })[] {
  return db
    .prepare(
      `SELECT p.name AS project, ${TOTALS} FROM ai_requests r JOIN projects p ON p.id = r.project_id
       WHERE r.started_at > ? GROUP BY r.project_id ORDER BY cost DESC, requests DESC`,
    )
    .all(iso(now - MONTH_MS))
    .map((row) => ({ project: String(row.project), ...totals(row) }))
}

export function pruneAiRequests(db: DatabaseSync, now: number): number {
  return Number(db.prepare('DELETE FROM ai_requests WHERE started_at < ?').run(iso(now - KEEP_MS)).changes)
}
