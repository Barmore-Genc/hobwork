import type { IncomingMessage, ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { verifyAgentToken, type Agent } from '../agents.ts'
import type { Delivery } from '../delivery.ts'
import type { HomeAssistant } from '../homeassistant/client.ts'
import type { Host } from '../host.ts'
import type { Runtime } from '../runtime/runtime.ts'
import type { ExecWorkspaceVm, WorkspaceManager } from '../workspaces.ts'
import { createMcpServer } from './server.ts'

export const MCP_PATH = '/mcp'

// A function so MCP OAuth can replace static agent tokens without touching the
// request handling.
export type McpAuthenticator = (req: IncomingMessage) => Agent | undefined

export function bearerTokenAuth(host: Host): McpAuthenticator {
  return (req) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return undefined
    return verifyAgentToken(host.db, header.slice('Bearer '.length).trim())
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
  homeAssistant?: HomeAssistant
  runtime?: Runtime
}) {
  const authenticate = options.authenticate ?? bearerTokenAuth(options.host)

  // Stateless: every POST gets its own server and transport, so nothing has to
  // be tracked between requests and a host restart loses no sessions.
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const agent = authenticate(req)
    if (!agent) {
      return jsonRpcError(res, 401, 'Send an agent token as "Authorization: Bearer <token>"', {
        'www-authenticate': 'Bearer realm="Hobwork"',
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
      homeAssistant: options.homeAssistant,
      runtime: options.runtime,
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
