import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { GIT_PREFIX, handleGit } from './git-http.ts'
import type { Host } from './host.ts'
import { createMcpHandler, MCP_PATH, type McpAuthenticator } from './mcp/http.ts'
import { listProjects } from './projects.ts'
import { createWorkspaceManager, type ExecWorkspaceVm, type WorkspaceManager } from './workspaces.ts'

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function createApp(
  host: Host,
  options: { workspaces?: WorkspaceManager<ExecWorkspaceVm>; authenticate?: McpAuthenticator } = {},
): Server {
  const handleMcp = createMcpHandler({
    host,
    workspaces: options.workspaces ?? createWorkspaceManager<ExecWorkspaceVm>(host),
    authenticate: options.authenticate,
  })

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const { pathname, search } = new URL(req.url ?? '/', 'http://localhost')

    if (pathname.startsWith(GIT_PREFIX)) {
      return handleGit(host, req, res, pathname, search.slice(1))
    }
    if (pathname === MCP_PATH) {
      return void handleMcp(req, res)
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && pathname === '/api/projects') {
      return json(
        res,
        200,
        listProjects(host).map(({ name, defaultBranch }) => ({ name, defaultBranch })),
      )
    }
    json(res, 404, { error: 'not found' })
  })
}
