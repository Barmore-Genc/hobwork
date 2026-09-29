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

export type ProjectDetail = {
  name: string
  createdAt: string
  status: ProjectStatus
  // The version that runs now. It can differ from the newest while a deploy runs or after one failed.
  currentVersion: number | null
  versions: Version[]
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  // The host refuses state-changing requests without this header (CSRF protection).
  if (method !== 'GET') headers['x-hobwork-csrf'] = '1'
  if (body !== undefined) headers['content-type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
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
