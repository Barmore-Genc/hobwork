import { Readable } from 'node:stream'
import { GIT_PATH, mentionsReceivePack, startGitBackend } from './git-http.ts'
import type { Host } from './host.ts'
import { SESSION_HEADER, type ExecWorkspaceVm, type WorkspaceManager } from './workspaces.ts'

export const WORKSPACE_GIT_PREFIX = '/git/'

const ZERO_ID = '0'.repeat(40)
const COMMAND = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

// A push request starts with pkt-lines, one ref update each, up to a flush
// packet. The pack follows. Returns what is wrong with the request, if anything.
function checkPushCommands(body: Buffer, allowedRef: string): string | undefined {
  let position = 0
  for (;;) {
    const length = /^[0-9a-f]{4}$/.test(body.subarray(position, position + 4).toString('latin1'))
      ? Number.parseInt(body.subarray(position, position + 4).toString('latin1'), 16)
      : -1
    if (length === 0) return undefined
    if (length < 4 || position + length > body.length) return 'Malformed push request'
    const line = body
      .subarray(position + 4, position + length)
      .toString('latin1')
      .split('\0')[0]
      ?.replace(/\n$/, '')
    position += length
    if (line?.startsWith('shallow ')) continue
    const command = COMMAND.exec(line ?? '')
    if (!command) return 'Unsupported push request'
    const [, , to = '', ref = ''] = command
    if (ref !== allowedRef) return `This workspace can only push to ${allowedRef}`
    if (to === ZERO_ID) return `${allowedRef} cannot be deleted by a push`
  }
}

// git smart HTTP for the workspace VM at hobwork.internal/git/<hob>.git. The
// VM's commit tool pushes here with the session token, and resets fetch from
// here. It is bound to the VM's hob and only accepts pushes to its branch. The
// pre-receive hook still refuses main.
export function createWorkspaceGit(options: {
  host: Host
  workspaces: WorkspaceManager<ExecWorkspaceVm>
}): (workspace: { project: string; branch: string }) => (request: Request) => Promise<Response> {
  const { host, workspaces } = options
  return ({ project, branch }) =>
    async (request) => {
      const url = new URL(request.url)
      if (!workspaces.sessionAgent(project, branch, request.headers.get(SESSION_HEADER) ?? '')) {
        return plain(401, 'git only works from the tools Hobwork runs in the workspace')
      }
      const match = GIT_PATH.exec(url.pathname)
      if (!match || url.pathname.includes('..') || match[1] !== project) return plain(404, 'Not found')
      if (request.method !== 'GET' && request.method !== 'POST') return plain(405, 'Method not allowed')
      const rest = match[2] ?? ''
      const query = url.search.replace(/^\?/, '')
      const push = mentionsReceivePack(rest, query)

      const body = request.method === 'POST' ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0)
      if (push && request.method === 'POST') {
        if (request.headers.get('content-encoding')) return plain(400, 'Unsupported push request')
        const problem = checkPushCommands(body, `refs/heads/${branch}`)
        if (problem) return plain(403, problem)
      }

      const header = (name: string) => request.headers.get(name) ?? ''
      const backend = startGitBackend(host, {
        project,
        rest,
        query,
        method: request.method,
        contentType: header('content-type'),
        contentLength: request.method === 'POST' ? String(body.length) : '',
        gitProtocol: header('git-protocol'),
        contentEncoding: header('content-encoding'),
        remoteUser: `workspace ${project}/${branch}`,
        remoteAddress: '',
        push,
      })
      backend.stdin.on('error', () => {})
      backend.stdin.end(body)
      try {
        const { status, headers, body: output } = await backend.response
        return new Response(Readable.toWeb(output) as ReadableStream, { status, headers })
      } catch {
        return plain(500, 'git backend failed')
      }
    }
}
