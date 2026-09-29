import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createApiRoutes } from './api/routes.ts'
import { createAuth } from './auth/auth.ts'
import { createOidcLogin } from './auth/oidc.ts'
import { createPasskeys } from './auth/passkeys.ts'
import { createAuthRoutes } from './auth/routes.ts'
import type { Backups } from './backup/backups.ts'
import { createBackupRoutes } from './backup/routes.ts'
import type { Allowlist, OidcConfig } from './config.ts'
import type { ProjectData } from './data/project-data.ts'
import { createDelivery, type Delivery } from './delivery.ts'
import { GIT_PREFIX, handleGit } from './git-http.ts'
import type { HomeAssistant } from './homeassistant/client.ts'
import type { Host } from './host.ts'
import { json } from './http.ts'
import { bearerTokenAuth, createMcpHandler, MCP_PATH, mcpAuth, type McpAuthenticator } from './mcp/http.ts'
import type { FetchedDocument } from './oauth/metadata-fetch.ts'
import { createOAuthServer } from './oauth/routes.ts'
import { createRuntimeHttp } from './runtime/http.ts'
import type { Runtime } from './runtime/runtime.ts'
import type { SecretStore } from './secrets.ts'
import { createStaticRoutes } from './static.ts'
import { createWorkspaceManager, type ExecWorkspaceVm, type WorkspaceManager } from './workspaces.ts'

export type WebOptions = {
  publicUrl: string
  allowlist: Allowlist
  oidc?: OidcConfig
  webDist?: string
  // Tests replace how client ID metadata documents are fetched and the clock.
  fetchClientMetadata?: (url: URL) => Promise<FetchedDocument>
  now?: () => number
}

export function createApp(
  host: Host,
  options: {
    workspaces?: WorkspaceManager<ExecWorkspaceVm>
    delivery?: Delivery
    authenticate?: McpAuthenticator
    homeAssistant?: HomeAssistant
    runtime?: Runtime
    data?: ProjectData
    secrets?: SecretStore
    backups?: Backups
    web?: WebOptions
  } = {},
): Server {
  const workspaces = options.workspaces ?? createWorkspaceManager<ExecWorkspaceVm>(host)
  const delivery = options.delivery ?? createDelivery(host, { workspaces })
  const web = options.web ?? { publicUrl: 'http://localhost', allowlist: { emails: [], subjects: [] } }
  const auth = createAuth({ db: host.db, publicUrl: web.publicUrl, allowlist: web.allowlist })
  const oauth = createOAuthServer({
    db: host.db,
    publicUrl: web.publicUrl,
    auth,
    mcpPath: MCP_PATH,
    fetchDocument: web.fetchClientMetadata,
    now: web.now,
  })
  // OAuth access tokens are bound to the MCP endpoint (RFC 8707), so project
  // routes accept static agent tokens only.
  const authenticate = options.authenticate ?? bearerTokenAuth(host)
  const handleMcp = createMcpHandler({
    host,
    workspaces,
    delivery,
    authenticate: options.authenticate ?? mcpAuth(host, oauth.verifyAccessToken),
    resourceMetadataUrl: oauth.resourceMetadataUrl,
    homeAssistant: options.homeAssistant,
    runtime: options.runtime,
    data: options.data,
    secrets: options.secrets,
  })

  const handleAuth = createAuthRoutes({
    db: host.db,
    allowlist: web.allowlist,
    auth,
    passkeys: createPasskeys({ db: host.db, publicUrl: web.publicUrl, allowlist: web.allowlist, auth, now: web.now }),
    oidc: web.oidc && createOidcLogin({ oidc: web.oidc, publicUrl: web.publicUrl, db: host.db, allowlist: web.allowlist, auth }),
  })
  const handleApi = createApiRoutes({
    host,
    auth,
    delivery,
    publicUrl: web.publicUrl,
    runtime: options.runtime,
    data: options.data,
    secrets: options.secrets,
  })
  const handleBackups = createBackupRoutes({ host, auth, backups: options.backups })
  const handleRuntime =
    options.runtime &&
    createRuntimeHttp(
      host,
      options.runtime,
      (req) => authenticate(req) !== undefined || auth.sessionUser(req) !== undefined,
      (req) => auth.sessionUser(req) !== undefined,
    )
  const handleStatic = createStaticRoutes({ webDist: web.webDist })

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname, search } = new URL(req.url ?? '/', 'http://localhost')

    if (pathname.startsWith(GIT_PREFIX)) {
      return handleGit(host, req, res, pathname, search.slice(1))
    }
    if (pathname === MCP_PATH) {
      return void handleMcp(req, res)
    }
    if (handleRuntime?.(req, res, pathname, search)) return
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true })
    }
    try {
      if (await oauth.handle(req, res, pathname, new URLSearchParams(search))) return
      if (await handleAuth(req, res, pathname, new URLSearchParams(search))) return
      if (await handleBackups(req, res, pathname)) return
      if (await handleApi(req, res, pathname, new URLSearchParams(search))) return
      if (!pathname.startsWith('/api/') && handleStatic(req, res, pathname)) return
      json(res, 404, { error: 'not found' })
    } catch (err) {
      console.error(`${req.method} ${pathname} failed`, err)
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the Hobwork server' })
      else res.destroy()
    }
  })
}
