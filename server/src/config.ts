import { resolve } from 'node:path'
import { loadBackupConfig, type BackupConfig } from './backup/config.ts'

export type HomeAssistantConnection = {
  url: string
  token: string
}

export type OidcConfig = {
  issuer: string
  clientId: string
  // Absent for a public client, which relies on PKCE alone.
  clientSecret?: string
  // Shown on the sign-in button.
  name: string
}

// Who may sign in: verified email addresses and OIDC subjects.
export type Allowlist = { emails: string[]; subjects: string[] }

export type Config = {
  dataDir: string
  port: number
  host: string
  // Origin the browser uses to reach the host. Session cookies are Secure when
  // it is https, the OIDC redirect URI is built from it, and state-changing
  // requests must come from it.
  publicUrl: string
  oidc?: OidcConfig
  allowlist: Allowlist
  webDist: string
  homeAssistant?: HomeAssistantConnection
  workspaceIdleTimeoutMs: number
  // Undefined when the SSH gateway is off.
  sshPort?: number
  // Key for secrets at rest. Without it, <dataDir>/secret.key is used.
  secretKey?: string
  // Undefined when backups are off.
  backup?: BackupConfig
}

const repoRoot = resolve(import.meta.dirname, '../..')

function httpUrl(name: string, value: string, example: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a URL like ${example}, got "${value}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must start with http:// or https://, got "${value}"`)
  }
  return url
}

function loadHomeAssistant(env: NodeJS.ProcessEnv): HomeAssistantConnection | undefined {
  const url = env.HOBWORK_HA_URL
  const token = env.HOBWORK_HA_TOKEN
  if (!url && !token) return undefined
  if (!url || !token) throw new Error('HOBWORK_HA_URL and HOBWORK_HA_TOKEN must be set together')
  httpUrl('HOBWORK_HA_URL', url, 'http://homeassistant.local:8123')
  return { url, token }
}

function loadPublicUrl(env: NodeJS.ProcessEnv, port: number): string {
  const value = env.HOBWORK_PUBLIC_URL
  if (!value) return `http://localhost:${port}`
  const url = httpUrl('HOBWORK_PUBLIC_URL', value, 'https://hobwork.example.com')
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`HOBWORK_PUBLIC_URL must be an origin without a path, like https://hobwork.example.com, got "${value}"`)
  }
  return url.origin
}

function loadOidc(env: NodeJS.ProcessEnv): OidcConfig | undefined {
  const issuer = env.HOBWORK_OIDC_ISSUER
  const clientId = env.HOBWORK_OIDC_CLIENT_ID
  if (!issuer && !clientId) return undefined
  if (!issuer || !clientId) throw new Error('HOBWORK_OIDC_ISSUER and HOBWORK_OIDC_CLIENT_ID must be set together')
  httpUrl('HOBWORK_OIDC_ISSUER', issuer, 'https://id.example.com')
  return {
    issuer,
    clientId,
    ...(env.HOBWORK_OIDC_CLIENT_SECRET ? { clientSecret: env.HOBWORK_OIDC_CLIENT_SECRET } : {}),
    name: env.HOBWORK_OIDC_NAME || 'Pocket ID',
  }
}

function loadAllowlist(env: NodeJS.ProcessEnv): Allowlist {
  const entries = (env.HOBWORK_ALLOWED_USERS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return {
    emails: entries.filter((e) => !e.startsWith('sub:')).map((e) => e.toLowerCase()),
    subjects: entries.filter((e) => e.startsWith('sub:')).map((e) => e.slice('sub:'.length)),
  }
}

function loadPort(name: string, value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be an integer from 0 to 65535, got "${value}"`)
  }
  return port
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = loadPort('HOBWORK_PORT', env.HOBWORK_PORT, 7420)
  const idleMinutes = Number(env.HOBWORK_WORKSPACE_IDLE_MINUTES ?? 30)
  if (!(idleMinutes > 0)) {
    throw new Error(
      `HOBWORK_WORKSPACE_IDLE_MINUTES must be a positive number, got "${env.HOBWORK_WORKSPACE_IDLE_MINUTES}"`,
    )
  }
  return {
    dataDir: resolve(repoRoot, env.HOBWORK_DATA_DIR ?? 'data'),
    port,
    host: env.HOBWORK_HOST ?? '127.0.0.1',
    publicUrl: loadPublicUrl(env, port),
    oidc: loadOidc(env),
    allowlist: loadAllowlist(env),
    webDist: resolve(repoRoot, 'web/dist'),
    homeAssistant: loadHomeAssistant(env),
    workspaceIdleTimeoutMs: idleMinutes * 60_000,
    sshPort: env.HOBWORK_SSH_PORT === 'off' ? undefined : loadPort('HOBWORK_SSH_PORT', env.HOBWORK_SSH_PORT, 2222),
    ...(env.HOBWORK_SECRET_KEY ? { secretKey: env.HOBWORK_SECRET_KEY } : {}),
    backup: loadBackupConfig(env),
  }
}
