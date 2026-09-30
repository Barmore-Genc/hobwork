import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { GIT_PATH, mentionsReceivePack, startGitBackend } from './git-http.ts'
import type { Host } from './host.ts'
import { SESSION_HEADER, type ExecWorkspaceVm, type WorkspaceManager } from './workspaces.ts'

export const WORKSPACE_GIT_PREFIX = '/git/'

const ZERO_ID = '0'.repeat(40)
const COMMAND = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/
// A workspace pushes one ref, so this only has to leave room for shallow lines.
const MAX_PUSH_COMMANDS_BYTES = 1024 * 1024

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

// Pushes stream into git: a pack can be larger than what Gondolin buffers
// (64MB), and git's receive.maxInputSize limits it as it arrives. Gets the
// request head only.
export function streamsWorkspaceGitBody(request: Request): boolean {
  const url = new URL(request.url)
  return (
    request.method === 'POST' &&
    url.pathname.startsWith(WORKSPACE_GIT_PREFIX) &&
    mentionsReceivePack(url.pathname, url.search.replace(/^\?/, ''))
  )
}

// A push request starts with pkt-lines, one ref update each, up to a flush
// packet. The pack follows. Returns what is wrong with the request, if
// anything, or undefined when more of the body is needed to tell.
export function checkPushCommands(body: Buffer, allowedRef: string): { problem?: string } | undefined {
  let position = 0
  for (;;) {
    if (position + 4 > body.length) return undefined
    const prefix = body.subarray(position, position + 4).toString('latin1')
    const length = /^[0-9a-f]{4}$/.test(prefix) ? Number.parseInt(prefix, 16) : -1
    if (length === 0) return {}
    if (length < 4) return { problem: 'Malformed push request' }
    if (position + length > body.length) return undefined
    const line = body
      .subarray(position + 4, position + length)
      .toString('latin1')
      .split('\0')[0]
      ?.replace(/\n$/, '')
    position += length
    if (line?.startsWith('shallow ')) continue
    const command = COMMAND.exec(line ?? '')
    if (!command) return { problem: 'Unsupported push request' }
    const [, , to = '', ref = ''] = command
    if (ref !== allowedRef) return { problem: `This workspace can only push to ${allowedRef}` }
    if (to === ZERO_ID) return { problem: `${allowedRef} cannot be deleted by a push` }
  }
}

// Reads the body until its push commands can be checked. Returns what it read.
async function readPushCommands(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  allowedRef: string,
): Promise<{ problem: string } | { read: Buffer }> {
  let read: Buffer = Buffer.alloc(0)
  for (;;) {
    const checked = checkPushCommands(read, allowedRef)
    if (checked) return checked.problem ? { problem: checked.problem } : { read }
    if (read.length > MAX_PUSH_COMMANDS_BYTES) return { problem: 'Malformed push request' }
    const { done, value } = await reader.read()
    if (done) return { problem: 'Malformed push request' }
    read = Buffer.concat([read, value])
  }
}

async function* bodyChunks(first: Buffer, reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<Uint8Array> {
  try {
    if (first.length) yield first
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    // When git stops reading early, Gondolin drops the rest of the upload.
    await reader.cancel().catch(() => {})
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
      if (!workspaces.sessionAgent(project, branch, request.headers.get(SESSION_HEADER) ?? '', { tool: true })) {
        return plain(401, 'git only works from the tools Hobwork runs in the workspace')
      }
      const match = GIT_PATH.exec(url.pathname)
      if (!match || url.pathname.includes('..') || match[1] !== project) return plain(404, 'Not found')
      if (request.method !== 'GET' && request.method !== 'POST') return plain(405, 'Method not allowed')
      const rest = match[2] ?? ''
      const query = url.search.replace(/^\?/, '')
      const push = mentionsReceivePack(rest, query)

      const reader = request.method === 'POST' ? request.body?.getReader() : undefined
      let read: Buffer = Buffer.alloc(0)
      if (push && request.method === 'POST') {
        if (!reader) return plain(403, 'Malformed push request')
        const refuse = async (message: string) => {
          await reader.cancel().catch(() => {})
          return plain(403, message)
        }
        if (request.headers.get('content-encoding')) return refuse('Unsupported push request')
        const commands = await readPushCommands(reader, `refs/heads/${branch}`)
        if ('problem' in commands) return refuse(commands.problem)
        read = commands.read
      }

      const header = (name: string) => request.headers.get(name) ?? ''
      const backend = startGitBackend(host, {
        project,
        rest,
        query,
        method: request.method,
        contentType: header('content-type'),
        // Chunked bodies have none, and git then reads to the end.
        contentLength: request.method === 'POST' ? header('content-length') : '',
        gitProtocol: header('git-protocol'),
        contentEncoding: header('content-encoding'),
        remoteUser: `workspace ${project}/${branch}`,
        remoteAddress: '',
        push,
      })
      backend.stdin.on('error', () => {})
      if (reader) {
        // Gondolin stops reading the guest's body once the response is
        // returned, so the whole body goes to git first. When the body stops
        // early, git fails the request itself.
        await pipeline(Readable.from(bodyChunks(read, reader)), backend.stdin).catch(() => {})
      } else {
        backend.stdin.end()
      }
      try {
        const { status, headers, body: output } = await backend.response
        return new Response(Readable.toWeb(output) as ReadableStream, { status, headers })
      } catch {
        return plain(500, 'git backend failed')
      }
    }
}
