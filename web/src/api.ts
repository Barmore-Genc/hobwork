export type SessionUser = { name: string; email: string | null }

export type Session = {
  user: SessionUser | null
  signIn: { oidc: { name: string } | null }
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

export type Agent = { id: number; name: string; createdAt: string; tokens: AgentToken[] }

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
}
