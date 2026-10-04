import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { allowsProject } from './access.ts'
import type { AiConfig } from './ai/settings.ts'
import { aiSettingsRoutes } from './api/ai-settings.ts'
import { haServicesRoutes } from './api/ha-services.ts'
import { allActivityRoutes } from './api/all-activity.ts'
import { homeAssistantSettingsRoutes } from './api/homeassistant-settings.ts'
import { projectDeletionRoutes } from './api/project-deletion.ts'
import { projectLifecycleRoutes } from './api/project-lifecycle.ts'
import { userRoutes } from './api/router.ts'
import { createApiRoutes } from './api/routes.ts'
import { createAppHttp } from './apps/http.ts'
import { createAppOrigins } from './apps/origins.ts'
import { createAuth } from './auth/auth.ts'
import { createOidcLogin } from './auth/oidc.ts'
import { createPasskeys } from './auth/passkeys.ts'
import { createAuthRoutes } from './auth/routes.ts'
import type { Backups } from './backup/backups.ts'
import { createBackupRoutes } from './backup/routes.ts'
import { clientAddress, parseTrustedProxies, type TrustedProxies } from './client-address.ts'
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
import { json, refuseUpgrade } from './http.ts'
import { createLiveSockets } from './live.ts'
import { bearerTokenAuth, createMcpHandler, MCP_PATH, mcpAuth, type McpAuthenticator } from './mcp/http.ts'
import type { FetchedDocument } from './oauth/metadata-fetch.ts'
import { createOAuthServer } from './oauth/routes.ts'
import { createRuntimeHttp } from './runtime/http.ts'
import type { Runtime } from './runtime/runtime.ts'
import type { SecretStore } from './secrets.ts'
import type { StorageUsage } from './storage.ts'
import { createStaticRoutes } from './static.ts'
import { createWorkspaceManager, type ExecWorkspaceVm, type WorkspaceManager } from './workspaces.ts'

export type WebOptions = {
  publicUrl: string
  // Team ID and bundle ID in /.well-known/apple-app-site-association.
  appleAppId?: string
  // Defaults to apps.<public host>.
  appsUrl?: string
  allowlist: Allowlist
  oidc?: OidcConfig
  webDist?: string
  // Empty when the host is reached directly.
  trustedProxies?: TrustedProxies
  // Answers every Host header instead of 421 for those that are neither the
  // public host nor an app host. Tests reach the server by its loopback address.
  anyHost?: boolean
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
    storage?: StorageUsage
    backups?: Backups
    devices?: Devices
    ai?: AiConfig
    sshPort?: number
    web?: WebOptions
  } = {},
): Server {
  const workspaces = options.workspaces ?? createWorkspaceManager<ExecWorkspaceVm>(host)
  const delivery = options.delivery ?? createDelivery(host, { workspaces })
  const web = options.web ?? { publicUrl: 'http://localhost', allowlist: { emails: [], subjects: [] }, anyHost: true }
  const publicHostname = new URL(web.publicUrl).hostname
  const trustedProxies = web.trustedProxies ?? parseTrustedProxies('')
  const addressOf = (req: IncomingMessage) => clientAddress(req, trustedProxies)
  const auth = createAuth({ db: host.db, publicUrl: web.publicUrl, allowlist: web.allowlist })
  const devices = options.devices ?? createDevices({ host, allowlist: web.allowlist, publicUrl: web.publicUrl })
  const oauth = createOAuthServer({
    db: host.db,
    publicUrl: web.publicUrl,
    auth,
    mcpPath: MCP_PATH,
    clientAddress: addressOf,
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
    storage: options.storage,
    devices,
    ai: options.ai,
    appOrigin: origins.origin,
    appsUrl: origins.appsUrl,
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
    workspaces,
    publicUrl: web.publicUrl,
    appOrigin: origins.origin,
    runtime: options.runtime,
    data: options.data,
    secrets: options.secrets,
    storage: options.storage,
  })
  const handleBackups = createBackupRoutes({ host, auth, backups: options.backups })
  const handleDevices = createDeviceRoutes({
    db: host.db,
    auth,
    allowlist: web.allowlist,
    publicUrl: web.publicUrl,
    devices,
    appleAppId: web.appleAppId,
  })
  const deviceSockets = createDeviceSockets({ db: host.db, allowlist: web.allowlist, devices })
  const liveSockets = createLiveSockets({ db: host.db, auth, publicUrl: web.publicUrl })
  const handleUserApi = userRoutes(auth, [
    ...allActivityRoutes(host),
    ...aiSettingsRoutes({ host, ai: options.ai, secrets: options.secrets }),
    ...haServicesRoutes({ host }),
    ...deviceUserRoutes({ db: host.db, devices, publicUrl: web.publicUrl }),
    ...projectDeletionRoutes({
      host,
      workspaces,
      delivery,
      runtime: options.runtime,
      data: options.data,
      storage: options.storage,
    }),
    ...projectLifecycleRoutes({
      host,
      workspaces,
      delivery,
      runtime: options.runtime,
      data: options.data,
      storage: options.storage,
    }),
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
      authorizeRoute: (req, project) => {
        const agent = authenticate(req)
        if (!agent) return 'unauthenticated'
        // GET and HEAD routes only read, by the usual HTTP convention.
        const reads = req.method === 'GET' || req.method === 'HEAD'
        return allowsProject(agent.access, project) && (reads || !agent.access.readOnly) ? 'allowed' : 'forbidden'
      },
      appOrigin: (project) => origins.origin({ project }),
    })
  const handleStatic = createStaticRoutes({ webDist: web.webDist, appsUrl: origins.appsUrl })

  // Requests with any other Host header come from a name someone else points at
  // this host (DNS rebinding, a stray record, the apps host itself), and would
  // otherwise reach Hobwork's API and UI under it. Health checks by address have
  // no host name to match, and the answer names nothing.
  const hostAllowed = (req: IncomingMessage) => {
    if (web.anyHost) return true
    try {
      return new URL(`http://${req.headers.host}`).hostname === publicHostname
    } catch {
      return false
    }
  }
  const misdirected = (res: ServerResponse) => {
    res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(`This is not the address of this Hobwork host. Use ${web.publicUrl}.\n`)
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (apps.isAppRequest(req)) return apps.handle(req, res)
    res.setHeader('x-content-type-options', 'nosniff')
    const { pathname, search } = new URL(req.url ?? '/', 'http://localhost')
    if (!hostAllowed(req) && !(req.method === 'GET' && pathname === '/api/health')) return misdirected(res)

    if (pathname.startsWith(GIT_PREFIX)) {
      return handleGit(host, req, res, pathname, search.slice(1), addressOf(req))
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
    if (apps.isAppRequest(req)) return socket.destroy()
    if (!hostAllowed(req)) return refuseUpgrade(socket, 421, 'This is not the address of this Hobwork host')
    if (!deviceSockets.handleUpgrade(req, socket, head) && !liveSockets.handleUpgrade(req, socket, head)) socket.destroy()
  })
  server.on('close', () => deviceSockets.close())
  // Upgraded sockets keep the server from closing, and nothing else ends
  // these: pages stay connected as long as they are open.
  const close = server.close.bind(server)
  server.close = ((callback?: (err?: Error) => void) => {
    liveSockets.close()
    return close(callback)
  }) as typeof server.close
  return server
}
