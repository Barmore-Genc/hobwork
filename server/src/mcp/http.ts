import type { IncomingMessage, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { verifyAgentToken, type AuthenticatedAgent } from '../agents.ts'
import type { AppTarget } from '../apps/origins.ts'
import type { ProjectData } from '../data/project-data.ts'
import type { Delivery } from '../delivery.ts'
import type { Devices } from '../devices/devices.ts'
import type { HomeAssistant } from '../homeassistant/client.ts'
import type { Host } from '../host.ts'
import type { Runtime } from '../runtime/runtime.ts'
import type { SecretStore } from '../secrets.ts'
import type { ExecWorkspaceVm, WorkspaceManager } from '../workspaces.ts'
import { createMcpServer } from './server.ts'
import type { SshAddress } from './ssh-keys.ts'

export const MCP_PATH = '/mcp'

export type McpAuthenticator = (req: IncomingMessage) => AuthenticatedAgent | undefined

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined
}

export function bearerTokenAuth(host: Host): McpAuthenticator {
  return (req) => {
    const token = bearerToken(req)
    return token ? verifyAgentToken(host.db, token) : undefined
  }
}

// Static agent tokens (Claude Code with --header) and OAuth access tokens
// issued for this MCP endpoint.
export function mcpAuth(host: Host, verifyAccessToken: (token: string) => AuthenticatedAgent | undefined): McpAuthenticator {
  return (req) => {
    const token = bearerToken(req)
    if (!token) return undefined
    return verifyAgentToken(host.db, token) ?? verifyAccessToken(token)
  }
}

function jsonRpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

export function createMcpHandler(options: {
  host: Host
  workspaces: WorkspaceManager<ExecWorkspaceVm>
  delivery: Delivery
  authenticate?: McpAuthenticator
  // RFC 9728: sent in the 401 challenge so OAuth clients find the authorization server.
  resourceMetadataUrl?: string
  ssh?: SshAddress
  homeAssistant?: HomeAssistant
  runtime?: Runtime
  data?: ProjectData
  secrets?: SecretStore
  devices?: Devices
  appOrigin?: (target: AppTarget) => string | undefined
}) {
  const authenticate = options.authenticate ?? bearerTokenAuth(options.host)

  // Stateless: every POST gets its own server and transport, so nothing has to
  // be tracked between requests and a host restart loses no sessions.
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const agent = authenticate(req)
    if (!agent) {
      const challenge = ['Bearer realm="Hobwork"']
      if (options.resourceMetadataUrl) challenge.push(`resource_metadata="${options.resourceMetadataUrl}"`)
      if (bearerToken(req)) challenge.push('error="invalid_token"')
      return jsonRpcError(res, 401, 'Sign in with OAuth or send an agent token as "Authorization: Bearer <token>"', {
        'www-authenticate': challenge.join(', '),
      })
    }
    if (req.method !== 'POST') {
      return jsonRpcError(res, 405, 'Method not allowed', { allow: 'POST' })
    }

    const server = createMcpServer({
      host: options.host,
      workspaces: options.workspaces,
      delivery: options.delivery,
      agent,
      ssh: options.ssh,
      homeAssistant: options.homeAssistant,
      runtime: options.runtime,
      data: options.data,
      secrets: options.secrets,
      devices: options.devices,
      appOrigin: options.appOrigin,
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      console.error('MCP request failed', err)
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error')
    }
  }
}
