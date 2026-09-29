import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'

export type SessionUser = { name: string; email: string | null }

export type Session = {
  user: SessionUser | null
  signIn: { oidc: { name: string } | null; passkey: boolean }
}

export type ProjectStatus = 'ready' | 'running' | 'updating'

export type Version = {
  number: number
  summary: string
  by: string | null
  restoredFrom: number | null
  createdAt: string
}

export type ProjectSummary = {
  name: string
  defaultBranch: string
  status: ProjectStatus
  currentVersion: Version | null
}

export type InvocationKind = 'route' | 'webhook' | 'cron' | 'trigger'
export type InvocationStatus = 'running' | 'ok' | 'error'

export type LastRun = { id: number; status: InvocationStatus; startedAt: string } | null

export type EntryPoints = {
  routes: { key: string; lastRun: LastRun }[]
  crons: { name: string; schedule: string; nextRun: string | null; lastRun: LastRun }[]
  webhooks: { name: string; tokenCreatedAt: string | null; lastRun: LastRun }[]
  triggers: { name: string; homeassistant: Record<string, unknown> | null; lastRun: LastRun }[]
}

export type DbStatus = {
  sizeBytes: number
  sizeWarning?: string
  slowQueries: { count: number; slowestMs: number; last?: { sql: string; durationMs: number; at: string } }
}

export type ProjectDetail = {
  name: string
  createdAt: string
  status: ProjectStatus
  // The version that runs now. It can differ from the newest while a deploy runs or after one failed.
  currentVersion: number | null
  versions: Version[]
  entryPoints: EntryPoints | null
  configError?: string
  egress: string[]
  database: DbStatus | null
  // The running version has a page to open.
  app: boolean
}

export type Invocation = {
  id: number
  version: number | null
  kind: InvocationKind
  name: string
  manual: boolean
  status: InvocationStatus
  httpStatus: number | null
  error: string | null
  startedAt: string
  durationMs: number | null
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogLine = {
  id: number
  invocationId: number | null
  source: 'handler' | 'runtime' | 'pipeline'
  level: LogLevel
  event: string | null
  message: string
  time: string
}

export type InvocationDetail = Invocation & { stack: string | null; logs: LogLine[] }

export type InvocationFilter = { kind?: InvocationKind; status?: InvocationStatus; since?: string; before?: number }

export type LogView = 'all' | 'events' | 'problems'

export type Secret = {
  name: string
  scope: 'project' | 'global'
  hosts: string[]
  createdAt: string
  updatedAt: string
}

export type AgentToken = {
  id: number
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

// An app the user connected through OAuth, such as Claude.
export type Connection = {
  id: number
  clientName: string
  redirectHost: string
  connectedBy: string | null
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export type SshKey = {
  id: number
  algorithm: string
  fingerprint: string
  comment: string
  createdAt: string
  lastUsedAt: string | null
}

export type Agent = {
  id: number
  name: string
  createdAt: string
  tokens: AgentToken[]
  connections: Connection[]
  sshKeys: SshKey[]
}

export type Passkey = { id: number; name: string; createdAt: string; lastUsedAt: string | null }

export type ConnectRequest = {
  // domain is set when the app proved it belongs to that domain.
  client: { name: string; uri: string | null; domain: string | null }
  redirectHost: string
  loopback: boolean
  agentName: string
}

export type CreatedToken = { agent: { id: number; name: string }; token: string }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Called when the session ends while the app is open, so it can show sign-in.
let onSignedOut: () => void = () => {}
export function setSignedOutHandler(handler: () => void) {
  onSignedOut = handler
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value))
  const text = search.toString()
  return text ? `?${text}` : ''
}

function secretsPath(project: string | null): string {
  return project === null ? '/api/secrets' : `/api/projects/${encodeURIComponent(project)}/secrets`
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {}
  // The host refuses state-changing requests without this header (CSRF protection).
  if (method !== 'GET') headers['x-hobwork-csrf'] = '1'
  if (body !== undefined) headers['content-type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new ApiError(0, 'Hobwork is not reachable. Check your connection and try again.')
  }
  if (res.status === 401) onSignedOut()
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  session: () => request<Session>('GET', '/api/session'),
  signOut: () => request<void>('POST', '/auth/logout'),
  projects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  project: (name: string) => request<ProjectDetail>('GET', `/api/projects/${encodeURIComponent(name)}`),
  restore: (project: string, version: number) =>
    request<{ version: Version; deployError?: string }>(
      'POST',
      `/api/projects/${encodeURIComponent(project)}/versions/${version}/restore`,
    ),
  invocations: (project: string, filter: InvocationFilter) =>
    request<{ invocations: Invocation[]; more: boolean }>(
      'GET',
      `/api/projects/${encodeURIComponent(project)}/invocations${query(filter)}`,
    ),
  invocation: (project: string, id: number) =>
    request<InvocationDetail>('GET', `/api/projects/${encodeURIComponent(project)}/invocations/${id}`),
  logs: (project: string, options: { view: LogView; after?: number; wait?: boolean }, signal?: AbortSignal) =>
    request<{ lines: LogLine[]; cursor: number }>(
      'GET',
      `/api/projects/${encodeURIComponent(project)}/logs${query({ ...options, wait: options.wait ? 1 : undefined })}`,
      undefined,
      signal,
    ),
  rotateWebhook: (project: string, name: string) =>
    request<{ url: string }>(
      'POST',
      `/api/projects/${encodeURIComponent(project)}/webhooks/${encodeURIComponent(name)}/token`,
    ),
  // Without a project: the secrets shared by every project.
  secrets: (project: string | null) => request<Secret[]>('GET', secretsPath(project)),
  saveSecret: (project: string | null, name: string, secret: { value?: string; hosts?: string[] }) =>
    request<Secret>('PUT', `${secretsPath(project)}/${encodeURIComponent(name)}`, secret),
  deleteSecret: (project: string | null, name: string) =>
    request<void>('DELETE', `${secretsPath(project)}/${encodeURIComponent(name)}`),
  agents: () => request<Agent[]>('GET', '/api/agents'),
  createAgent: (name: string) => request<CreatedToken>('POST', '/api/agents', { name }),
  createToken: (agentId: number) => request<CreatedToken>('POST', `/api/agents/${agentId}/tokens`),
  revokeToken: (tokenId: number) => request<void>('POST', `/api/tokens/${tokenId}/revoke`),
  revokeConnection: (id: number) => request<void>('POST', `/api/connections/${id}/revoke`),
  addSshKey: (agentId: number, publicKey: string) => request<SshKey>('POST', `/api/agents/${agentId}/ssh-keys`, { publicKey }),
  removeSshKey: (id: number) => request<void>('DELETE', `/api/ssh-keys/${id}`),
  connectRequest: (id: string) => request<ConnectRequest>('GET', `/api/oauth/requests/${encodeURIComponent(id)}`),
  approveConnect: (id: string, agentName: string) =>
    request<{ redirectTo: string }>('POST', `/api/oauth/requests/${encodeURIComponent(id)}/approve`, { agentName }),
  denyConnect: (id: string) =>
    request<{ redirectTo: string }>('POST', `/api/oauth/requests/${encodeURIComponent(id)}/deny`),
  passkeys: () => request<Passkey[]>('GET', '/api/passkeys'),
  deletePasskey: (id: number) => request<void>('DELETE', `/api/passkeys/${id}`),

  // Both throw the browser's error when the person cancels the passkey prompt.
  async addPasskey(name: string): Promise<Passkey> {
    const { flowId, options } = await request<{ flowId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
      'POST',
      '/api/passkeys/options',
    )
    const response = await startRegistration({ optionsJSON: options })
    return request<Passkey>('POST', '/api/passkeys', { flowId, name, response })
  },
  async signInWithPasskey(): Promise<void> {
    const { flowId, options } = await request<{ flowId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
      'POST',
      '/auth/passkey/options',
    )
    const response = await startAuthentication({ optionsJSON: options })
    await request<unknown>('POST', '/auth/passkey', { flowId, response })
  },
}
