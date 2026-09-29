import { createHash, randomBytes } from 'node:crypto'
import { publishChange } from '../changes.ts'
import type { Host } from '../host.ts'
import { requireProject } from '../projects.ts'

// Webhooks are served on the hob's own app origin: <app origin>/_hobwork/hooks/<name>/<token>.
export const HOOKS_PREFIX = '/_hobwork/hooks/'
// Before webhooks moved to app origins they were at <Hobwork origin>/hooks/<hob>/<name>/<token>.
export const LEGACY_HOOKS_PREFIX = '/hooks/'

// Same reasoning as agent tokens: 256 random bits need no slow hash.
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function webhookUrl(appOrigin: string, name: string, token: string): string {
  return `${appOrigin}${HOOKS_PREFIX}${name}/${token}`
}

// Only the hash is stored, so the URL is shown once; rotating replaces the old
// token right away.
export function rotateWebhookToken(host: Host, project: string, name: string): string {
  const { id } = requireProject(host, project)
  const token = randomBytes(32).toString('base64url')
  host.db
    .prepare(
      `INSERT INTO webhook_tokens (project_id, name, token_hash) VALUES (?, ?, ?)
       ON CONFLICT (project_id, name) DO UPDATE SET token_hash = excluded.token_hash,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(id, name, hashToken(token))
  publishChange(host.db, { kind: 'project', project })
  return token
}

export function verifyWebhookToken(host: Host, project: string, name: string, token: string): boolean {
  const row = host.db
    .prepare(
      `SELECT 1 FROM webhook_tokens w JOIN projects p ON p.id = w.project_id
       WHERE p.name = ? AND w.name = ? AND w.token_hash = ?`,
    )
    .get(project, name, hashToken(token))
  return row !== undefined
}

// Branch previews have their own origin and so their own URLs and tokens.
export function rotateBranchWebhookToken(host: Host, project: string, branch: string, name: string): string {
  const { id } = requireProject(host, project)
  const token = randomBytes(32).toString('base64url')
  host.db
    .prepare(
      `INSERT INTO branch_webhook_tokens (project_id, branch, name, token_hash) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, branch, name) DO UPDATE SET token_hash = excluded.token_hash,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run(id, branch, name, hashToken(token))
  return token
}

export function verifyBranchWebhookToken(host: Host, project: string, branch: string, name: string, token: string): boolean {
  const row = host.db
    .prepare(
      `SELECT 1 FROM branch_webhook_tokens w JOIN projects p ON p.id = w.project_id
       WHERE p.name = ? AND w.branch = ? AND w.name = ? AND w.token_hash = ?`,
    )
    .get(project, branch, name, hashToken(token))
  return row !== undefined
}

export function webhookTokenCreatedAt(host: Host, project: string, name: string): string | undefined {
  const row = host.db
    .prepare(
      `SELECT w.created_at FROM webhook_tokens w JOIN projects p ON p.id = w.project_id
       WHERE p.name = ? AND w.name = ?`,
    )
    .get(project, name)
  return row ? String(row.created_at) : undefined
}
