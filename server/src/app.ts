import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { allActivityRoutes } from './api/all-activity.ts'
import { homeAssistantSettingsRoutes } from './api/homeassistant-settings.ts'
import { projectDeletionRoutes } from './api/project-deletion.ts'
import { userRoutes } from './api/router.ts'
import { createApiRoutes } from './api/routes.ts'
import { createAppHttp } from './apps/http.ts'
import { createAppOrigins, parseLabel } from './apps/origins.ts'
import { createAuth } from './auth/auth.ts'
import { createOidcLogin } from './auth/oidc.ts'
import { createPasskeys } from './auth/passkeys.ts'
import { createAuthRoutes } from './auth/routes.ts'
import type { Backups } from './backup/backups.ts'
import { createBackupRoutes } from './backup/routes.ts'
import { defaultAppsUrl, type Allowlist, type OidcConfig } from './config.ts'
import type { ProjectData } from './data/project-data.ts'
import { createDelivery, type Delivery } from './delivery.ts'
import { createDevices, type Devices } from './devices/devices.ts'
import { createDeviceRoutes, deviceUserRoutes } from './devices/routes.ts'
import { createDeviceSockets } from './devices/socket.ts'
import { GIT_PREFIX, handleGit } from './git-http.ts'
import type { HomeAssistant } from './homeassistant/client.ts'
import type { HomeAssistantSettings } from './homeassistant/settings.ts'
import type { Host } from './host.ts'
import { json } from './http.ts'
import { bearerTokenAuth, createMcpHandler, MCP_PATH, mcpAuth, type McpAuthenticator } from './mcp/http.ts'
import type { FetchedDocument } from './oauth/metadata-fetch.ts'
import { createOAuthServer } from './oauth/routes.ts'
import { createRuntimeHttp } from './runtime/http.ts'
import type { Runtime } from './runtime/runtime.ts'
import type { SecretStore } from './secrets.ts'
import { getProject } from './projects.ts'
import { createStaticRoutes } from './static.ts'
import { createWorkspaceManager, type ExecWorkspaceVm, type WorkspaceManager } from './workspaces.ts'

export type WebOptions = {
  publicUrl: string
  // Defaults to apps.<public host>.
  appsUrl?: string
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
    homeAssistantSettings?: HomeAssistantSettings
    runtime?: Runtime
    data?: ProjectData
    secrets?: SecretStore
    backups?: Backups
    devices?: Devices
    sshPort?: number
    web?: WebOptions
  } = {},
): Server {
  const workspaces = options.workspaces ?? createWorkspaceManager<ExecWorkspaceVm>(host)
  const delivery = options.delivery ?? createDelivery(host, { workspaces })
  const web = options.web ?? { publicUrl: 'http://localhost', allowlist: { emails: [], subjects: [] } }
  const auth = createAuth({ db: host.db, publicUrl: web.publicUrl, allowlist: web.allowlist })
  const devices = options.devices ?? createDevices({ host, allowlist: web.allowlist })
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
  const origins = createAppOrigins(web.appsUrl ?? defaultAppsUrl(web.publicUrl))
  const handleMcp = createMcpHandler({
    host,
    workspaces,
    delivery,
    authenticate: options.authenticate ?? mcpAuth(host, oauth.verifyAccessToken),
    resourceMetadataUrl: oauth.resourceMetadataUrl,
    publicUrl: web.publicUrl,
    ssh: options.sshPort === undefined ? undefined : { host: new URL(web.publicUrl).hostname, port: options.sshPort },
    homeAssistant: options.homeAssistant,
    runtime: options.runtime,
    data: options.data,
    secrets: options.secrets,
    devices,
    appOrigin: origins.origin,
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
    appOrigin: origins.origin,
    runtime: options.runtime,
    data: options.data,
    secrets: options.secrets,
  })
  const handleBackups = createBackupRoutes({ host, auth, backups: options.backups })
  const handleDevices = createDeviceRoutes({ db: host.db, auth, allowlist: web.allowlist, publicUrl: web.publicUrl, devices })
  const deviceSockets = createDeviceSockets({ db: host.db, allowlist: web.allowlist, devices })
  const handleUserApi = userRoutes(auth, [
    ...allActivityRoutes(host),
    ...deviceUserRoutes({ db: host.db, devices }),
    ...projectDeletionRoutes({ host, workspaces, delivery, runtime: options.runtime, data: options.data }),
    ...homeAssistantSettingsRoutes({
      host,
      settings: options.homeAssistantSettings,
      ha: options.homeAssistant,
      runtime: options.runtime,
    }),
  ])
  const apps = createAppHttp({
    host,
    auth,
    allowlist: web.allowlist,
    origins,
    publicUrl: web.publicUrl,
    runtime: options.runtime,
    serveTheme: createStaticRoutes({}),
  })
  const handleRuntime =
    options.runtime &&
    createRuntimeHttp(host, options.runtime, {
      authorizeRoute: (req) => authenticate(req) !== undefined,
      appOrigin: (project) => origins.origin({ project }),
      resolvePreview: async (label) => {
        const { project, branchLabel } = parseLabel(label)
        if (branchLabel === undefined || !getProject(host, project)) return undefined
        const branch = await origins.resolveBranch(host, project, branchLabel)
        return branch === undefined ? undefined : { project, branch }
      },
    })
  const handleStatic = createStaticRoutes({ webDist: web.webDist })

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (apps.isAppRequest(req)) return apps.handle(req, res)
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
      if (await apps.handleHandoff(req, res, pathname, new URLSearchParams(search))) return
      if (await handleDevices(req, res, pathname, new URLSearchParams(search))) return
      if (await handleAuth(req, res, pathname, new URLSearchParams(search))) return
      if (await handleBackups(req, res, pathname)) return
      if (await handleUserApi(req, res, pathname, new URLSearchParams(search))) return
      if (await handleApi(req, res, pathname, new URLSearchParams(search))) return
      if (!pathname.startsWith('/api/') && handleStatic(req, res, pathname)) return
      json(res, 404, { error: 'not found' })
    } catch (err) {
      console.error(`${req.method} ${pathname} failed`, err)
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong on the Hobwork server' })
      else res.destroy()
    }
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (apps.isAppRequest(req) || !deviceSockets.handleUpgrade(req, socket, head)) socket.destroy()
  })
  server.on('close', () => deviceSockets.close())
  return server
}
