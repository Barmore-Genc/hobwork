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
  installScripts: { added: string[]; removed: string[] }
  createdAt: string
}

export type ProjectSummary = {
  name: string
  defaultBranch: string
  status: ProjectStatus
  currentVersion: Version | null
  iconUrl: string
  // Null until the host has measured the project.
  storage?: StorageUse | null
}

// Bytes per part of a project.
export type StorageUse = {
  total: number
  database: number
  branchDatabases: number
  workspaces: number
  repo: number
  builds: number
  logs: number
  measuredAt: string
}

export type InvocationKind = 'route' | 'webhook' | 'cron' | 'trigger'
export type InvocationStatus = 'running' | 'ok' | 'error'

export type LastRun = { id: number; status: InvocationStatus; startedAt: string } | null

export type EntryPoints = {
  routes: { key: string; lastRun: LastRun }[]
  crons: { name: string; schedule: string; nextRun: string | null; lastRun: LastRun }[]
  webhooks: { name: string; tokenCreatedAt: string | null; lastRun: LastRun }[]
  triggers: {
    name: string
    homeassistant: Record<string, unknown> | null
    device: { capability: string; event: string; device?: string; url?: string } | null
    lastRun: LastRun
  }[]
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
  iconUrl: string
  entryPoints: EntryPoints | null
  configError?: string
  egress: string[]
  database: DbStatus | null
  storage?: StorageUse | null
  // The running version has a page to open.
  app: boolean
  // Where the project's app lives, on its own origin.
  appUrl: string | null
}

export type Invocation = {
  id: number
  version: number | null
  // Set when a preview of this branch ran.
  branch: string | null
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

export type ActivityRun = Invocation & { project: string }

export type ProblemEvent = {
  id: number
  project: string
  branch: string | null
  invocationId: number | null
  level: LogLevel
  event: string
  message: string
  time: string
}

export type Problem = { type: 'run'; time: string; run: ActivityRun } | { type: 'event'; time: string; event: ProblemEvent }

export type ActivityFilter = InvocationFilter & { project?: string }

export type LogLine = {
  id: number
  branch: string | null
  invocationId: number | null
  source: 'handler' | 'runtime' | 'pipeline'
  level: LogLevel
  event: string | null
  message: string
  time: string
}

export type InvocationDetail = Invocation & { stack: string | null; logs: LogLine[] }

export type InvocationFilter = {
  kind?: InvocationKind
  status?: InvocationStatus
  since?: string
  before?: number
  branch?: string
}

export type DeletedProject = {
  id: string
  project: string
  deletedAt: string
  purgeAfter: string
  deletedBy: string | null
  versions: number
  lastVersion: { number: number; summary: string; createdAt: string } | null
  nameTaken: boolean
}

export type Branch = {
  name: string
  head: { sha: string; subject: string; updatedAt: string }
  unmergedCommits: number
  merged: { at: string; cleanupAfter: string } | null
  previewUrl: string | null
  running: boolean
  homeAssistant: { by: string; byAgent: boolean; grantedAt: string } | null
  recentRuns: Invocation[]
}

export type LogView = 'all' | 'events' | 'problems'

// Null when it was not done in the web UI or by an agent.
export type ChangedBy = { kind: 'user' | 'agent'; name: string } | null

export type SecretAssignment = {
  project: string
  envName: string
  assignedAt: string
  assignedBy: ChangedBy
}

export type Secret = {
  id: number
  name: string
  hosts: string[]
  headers: string[]
  pendingHostRequest: { id: number; hosts: string[]; agent: string | null } | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  updatedBy: string | null
  assignments: SecretAssignment[]
}

// Hosts an agent asked a secret to be sent to.
export type HostRequest = {
  id: number
  secret: { id: number; name: string; hosts: string[] }
  agent: string | null
  hosts: string[]
  reason: string
  createdAt: string
  decision: 'approved' | 'denied' | 'superseded' | null
  decidedAt: string | null
  decidedBy: string | null
}

// A secret as one project uses it.
export type ProjectSecret = {
  envName: string
  secretId: number
  secret: string
  hosts: string[]
  headers: string[]
  updatedAt: string
  assignedAt: string
  assignedBy: ChangedBy
}

export type NewSecret = {
  name: string
  value: string
  headers?: string[]
  assign?: { project: string; envName: string }
}

// What a key or sign-in may do. `projects: null` means every project.
export type Access = { readOnly: boolean; projects: string[] | null }

export type AgentToken = {
  id: number
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  access: Access
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
  access: Access
}

export type SshKeySource =
  | { via: 'web'; userName: string | null }
  | { via: 'agent'; token: { id: number; createdAt: string } | null; signIn: { id: number; clientName: string } | null }
  | { via: 'host' }

export type SshKey = {
  id: number
  name: string
  algorithm: string
  fingerprint: string
  comment: string
  addedFrom: SshKeySource | null
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export type Agent = {
  id: number
  name: string
  createdAt: string
  tokens: AgentToken[]
  connections: Connection[]
  sshKeys: SshKey[]
}

export type BackupRun = {
  id: number
  trigger: 'schedule' | 'manual'
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  totalBytes: number | null
  // New data sent to the bucket; unchanged data is not sent again.
  uploadedBytes: number | null
  error: string | null
}

export type BackupStatus =
  | { configured: false }
  | {
      configured: true
      destination: string
      schedule: string | null
      nextRun: string | null
      retention: { daily: number; weekly: number; monthly: number }
      running: boolean
      lastSuccess: BackupRun | null
      runs: BackupRun[]
    }

export type Passkey = { id: number; name: string; createdAt: string; lastUsedAt: string | null }

export type ConnectRequest = {
  // domain is set when the app proved it belongs to that domain.
  client: { name: string; uri: string | null; domain: string | null }
  redirectHost: string
  loopback: boolean
  // A free name for a new agent.
  agentName: string
  // Existing agents the app can connect as, with the access of their latest sign-in or key.
  agents: { id: number; name: string; access: Access | null }[]
  suggested: number | null
}

export type Device = {
  id: number
  // What projects use to reach it.
  name: string
  platform: 'ios' | 'macos'
  owner: string
  capabilities: string[]
  connected: boolean
  lastSeenAt: string | null
  appVersion: string | null
  push: boolean
  createdAt: string
  // False when the owner can no longer sign in to Hobwork.
  ownerAllowed: boolean
}

export type PairingRequest = { displayName: string; platform: 'ios' | 'macos'; name: string }

export type CreatedToken = { agent: { id: number; name: string }; token: string }

export type AiLimits = {
  throttle: boolean
  requestsPerMinute: number | null
  requestsPerHour: number | null
  costPerDay: number | null
  costPerMonth: number | null
}

export type AiUsageTotals = {
  requests: number
  refused: number
  promptTokens: number
  completionTokens: number
  cost: number
}

// The models hobs get. decisionModel null: none, so the model answers decisions too.
export type AiModels = { model: string; decisionModel: string | null; embeddingModel: string }

// null: the level above picks. decisionModel false: no decision model.
export type ModelChoice = { model: string | null; decisionModel: string | false | null; embeddingModel: string | null }

export type AiSettings = ModelChoice & {
  // What hobs get with these settings.
  models: AiModels
  limits: AiLimits
  // The server's models and the suggested limits.
  defaults: { models: AiModels; limits: AiLimits }
  updatedAt: string | null
  updatedBy: string | null
  usage: (AiUsageTotals & { project: string })[]
}

export type ProjectAi = {
  host: { models: AiModels; limits: AiLimits }
  project: ModelChoice & { limits: AiLimits | null; updatedAt: string | null; updatedBy: string | null }
  models: AiModels
  limits: AiLimits
  usage: {
    lastMinute: number
    lastHour: number
    day: AiUsageTotals
    month: AiUsageTotals
    models: (AiUsageTotals & { model: string | null })[]
  }
}

export type HomeAssistantSettings = {
  // env: set in the server configuration, which wins over this page.
  source: 'env' | 'settings' | null
  url: string | null
  tokenSet: boolean
  updatedAt: string | null
  updatedBy: string | null
  status: 'unconfigured' | 'connecting' | 'connected' | 'disconnected'
  version: string | null
  lastError: string | null
}

export type HomeAssistantTest = { ok: true; version: string | null } | { ok: false; error: string }

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

function projectSecretsPath(project: string): string {
  return `/api/projects/${encodeURIComponent(project)}/secrets`
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
  deleteProject: (project: string, confirm: string) =>
    request<{ deleted: string; recoverableUntil: string; trashDays: number }>(
      'DELETE',
      `/api/projects/${encodeURIComponent(project)}`,
      { confirm },
    ),
  renameProject: (project: string, name: string) =>
    request<{ name: string }>('POST', `/api/projects/${encodeURIComponent(project)}/rename`, { name }),
  deletedProjects: () => request<{ trashDays: number; projects: DeletedProject[] }>('GET', '/api/trash'),
  restoreDeletedProject: (id: string, name: string) =>
    request<{ name: string }>('POST', `/api/trash/${encodeURIComponent(id)}/restore`, { name }),
  versions: (project: string, before?: number) =>
    request<{ versions: Version[]; more: boolean }>(
      'GET',
      `/api/projects/${encodeURIComponent(project)}/versions${query({ before })}`,
    ),
  restore: (project: string, version: number) =>
    request<{ version: Version; deployError?: string }>(
      'POST',
      `/api/projects/${encodeURIComponent(project)}/versions/${version}/restore`,
    ),
  branches: (project: string) => request<Branch[]>('GET', `/api/projects/${encodeURIComponent(project)}/branches`),
  allowBranchHomeAssistant: (project: string, branch: string) =>
    request<{ by: string; grantedAt: string }>(
      'PUT',
      `/api/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch)}/home-assistant`,
    ),
  deleteBranch: (project: string, branch: string) =>
    request<void>('DELETE', `/api/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch)}`),
  stopBranchHomeAssistant: (project: string, branch: string) =>
    request<void>('DELETE', `/api/projects/${encodeURIComponent(project)}/branches/${encodeURIComponent(branch)}/home-assistant`),
  invocations: (project: string, filter: InvocationFilter) =>
    request<{ invocations: Invocation[]; more: boolean }>(
      'GET',
      `/api/projects/${encodeURIComponent(project)}/invocations${query(filter)}`,
    ),
  activity: (filter: ActivityFilter) =>
    request<{ invocations: ActivityRun[]; more: boolean }>('GET', `/api/activity${query(filter)}`),
  problems: (filter: { project?: string; before?: string }) =>
    request<{ items: Problem[]; more: boolean }>('GET', `/api/activity/problems${query(filter)}`),
  attention: (since: string) => request<{ count: number; more: boolean }>('GET', `/api/activity/attention${query({ since })}`),
  invocation: (project: string, id: number) =>
    request<InvocationDetail>('GET', `/api/projects/${encodeURIComponent(project)}/invocations/${id}`),
  logs: (project: string, options: { view: LogView; after?: number; limit?: number }, signal?: AbortSignal) =>
    request<{ lines: LogLine[]; cursor: number }>(
      'GET',
      `/api/projects/${encodeURIComponent(project)}/logs${query(options)}`,
      undefined,
      signal,
    ),
  rotateWebhook: (project: string, name: string) =>
    request<{ url: string }>(
      'POST',
      `/api/projects/${encodeURIComponent(project)}/webhooks/${encodeURIComponent(name)}/token`,
    ),
  secrets: () => request<Secret[]>('GET', '/api/secrets'),
  createSecret: (secret: NewSecret) => request<Secret>('POST', '/api/secrets', secret),
  updateSecret: (id: number, change: { name?: string; value?: string; hosts?: string[]; headers?: string[] }) =>
    request<Secret>('PATCH', `/api/secrets/${id}`, change),
  deleteSecret: (id: number) => request<void>('DELETE', `/api/secrets/${id}`),
  hostRequest: (id: number) => request<HostRequest>('GET', `/api/secrets/host-requests/${id}`),
  decideHostRequest: (id: number, approve: boolean) =>
    request<HostRequest>('POST', `/api/secrets/host-requests/${id}/${approve ? 'approve' : 'deny'}`),
  projectSecrets: (project: string) => request<ProjectSecret[]>('GET', projectSecretsPath(project)),
  assignSecret: (project: string, envName: string, secretId: number) =>
    request<ProjectSecret>('PUT', `${projectSecretsPath(project)}/${encodeURIComponent(envName)}`, { secretId }),
  unassignSecret: (project: string, envName: string) =>
    request<void>('DELETE', `${projectSecretsPath(project)}/${encodeURIComponent(envName)}`),
  agents: () => request<Agent[]>('GET', '/api/agents'),
  createAgent: (name: string, access: Access) => request<CreatedToken>('POST', '/api/agents', { name, access }),
  createToken: (agentId: number, access: Access) =>
    request<CreatedToken>('POST', `/api/agents/${agentId}/tokens`, { access }),
  revokeToken: (tokenId: number) => request<void>('POST', `/api/tokens/${tokenId}/revoke`),
  revokeConnection: (id: number) => request<void>('POST', `/api/connections/${id}/revoke`),
  addSshKey: (agentId: number, name: string, publicKey: string) =>
    request<SshKey>('POST', `/api/agents/${agentId}/ssh-keys`, { name, publicKey }),
  revokeSshKey: (id: number) => request<void>('POST', `/api/ssh-keys/${id}/revoke`),
  connectRequest: (id: string) => request<ConnectRequest>('GET', `/api/oauth/requests/${encodeURIComponent(id)}`),
  approveConnect: (id: string, agent: { agentId: number } | { agentName: string }, access: Access) =>
    request<{ redirectTo: string }>('POST', `/api/oauth/requests/${encodeURIComponent(id)}/approve`, {
      ...agent,
      access,
    }),
  denyConnect: (id: string) =>
    request<{ redirectTo: string }>('POST', `/api/oauth/requests/${encodeURIComponent(id)}/deny`),
  devices: () => request<{ devices: Device[]; push: boolean }>('GET', '/api/devices'),
  renameDevice: (id: number, name: string) => request<Device>('PATCH', `/api/devices/${id}`, { name }),
  revokeDevice: (id: number) => request<void>('POST', `/api/devices/${id}/revoke`),
  pairingRequest: (query: string) => request<PairingRequest>('GET', `/api/devices/pairing?${query}`),
  approvePairing: (query: Record<string, string>, name: string) =>
    request<{ redirectTo: string }>('POST', '/api/devices/pairing/approve', { request: query, name }),
  denyPairing: (query: Record<string, string>) =>
    request<{ redirectTo: string }>('POST', '/api/devices/pairing/deny', { request: query }),
  aiSettings: () => request<AiSettings>('GET', '/api/settings/ai'),
  saveAiSettings: (settings: ModelChoice & { limits: AiLimits }) =>
    request<AiSettings>('PUT', '/api/settings/ai', settings),
  projectAi: (project: string) => request<ProjectAi>('GET', `/api/projects/${encodeURIComponent(project)}/ai`),
  saveProjectAi: (project: string, settings: ModelChoice & { limits: AiLimits | null }) =>
    request<ProjectAi>('PUT', `/api/projects/${encodeURIComponent(project)}/ai`, settings),
  haServices: (project: string) =>
    request<{ services: string[] }>('GET', `/api/projects/${encodeURIComponent(project)}/home-assistant-services`),
  saveHaServices: (project: string, services: string[]) =>
    request<{ services: string[] }>('PUT', `/api/projects/${encodeURIComponent(project)}/home-assistant-services`, { services }),
  homeAssistant: () => request<HomeAssistantSettings>('GET', '/api/settings/homeassistant'),
  saveHomeAssistant: (settings: { url: string; token?: string }) =>
    request<HomeAssistantSettings>('PUT', '/api/settings/homeassistant', settings),
  testHomeAssistant: (settings: { url?: string; token?: string }) =>
    request<HomeAssistantTest>('POST', '/api/settings/homeassistant/test', settings),
  disconnectHomeAssistant: () => request<HomeAssistantSettings>('DELETE', '/api/settings/homeassistant'),
  passkeys: () => request<Passkey[]>('GET', '/api/passkeys'),
  backups: () => request<BackupStatus>('GET', '/api/backups'),
  startBackup: () => request<BackupRun>('POST', '/api/backups'),
  renamePasskey: (id: number, name: string) => request<Passkey>('PATCH', `/api/passkeys/${id}`, { name }),
  deletePasskey: (id: number) => request<void>('DELETE', `/api/passkeys/${id}`),

  // Both throw the browser's error when the person cancels the passkey prompt.
  // Without a name the host picks one from the password manager or the device.
  async addPasskey(name: string, device: string): Promise<Passkey> {
    const { flowId, options } = await request<{ flowId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
      'POST',
      '/api/passkeys/options',
    )
    const response = await startRegistration({ optionsJSON: options })
    return request<Passkey>('POST', '/api/passkeys', { flowId, name, device, response })
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
