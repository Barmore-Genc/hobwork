import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { PassThrough, type Readable } from 'node:stream'
import { allowsProject } from './access.ts'
import { verifyAgentToken, type AuthenticatedAgent } from './agents.ts'
import { publishChange } from './changes.ts'
import { gitEnv } from './git.ts'
import { reposDir, type Host } from './host.ts'
import { getProject, renamedProject } from './projects.ts'

export const GIT_PREFIX = '/git/'

const MAX_PUSH_BYTES = 512 * 1024 * 1024

export const GIT_PATH = /^\/git\/([a-z0-9-]+)\.git(\/[A-Za-z0-9._/-]*)$/

function authenticate(host: Host, req: IncomingMessage): AuthenticatedAgent | undefined {
  const header = req.headers.authorization
  if (!header?.startsWith('Basic ')) return undefined
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon === -1) return undefined
  return verifyAgentToken(host.db, decoded.slice(colon + 1))
}

function plain(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(`${message}\n`)
}

// git http-backend picks the service from a path suffix or the `service`
// parameter. Anything that mentions receive-pack anywhere, in any case or
// encoding, counts as a push, so no variation slips past a read-only token.
export function mentionsReceivePack(rest: string, query: string): boolean {
  const decoded = (text: string) => {
    try {
      return decodeURIComponent(text.replace(/\+/g, ' '))
    } catch {
      return text
    }
  }
  return [rest, query, decoded(rest), decoded(query)].some((part) => part.toLowerCase().includes('receive-pack'))
}

export function handleGit(
  host: Host,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: string,
  remoteAddress: string | undefined,
) {
  const match = GIT_PATH.exec(pathname)
  if (!match || pathname.includes('..')) return plain(res, 404, 'Not found')
  const [, project = '', rest = ''] = match

  const agent = authenticate(host, req)
  if (!agent) {
    return plain(res, 401, 'Use an agent token as the password', {
      'www-authenticate': 'Basic realm="Hobwork", charset="UTF-8"',
    })
  }
  if (!getProject(host, project)) {
    const renamed = renamedProject(host, project)
    return plain(
      res,
      404,
      renamed && allowsProject(agent.access, renamed.name)
        ? `Hob "${project}" was renamed to "${renamed.name}". Change the remote URL to ${GIT_PREFIX}${renamed.name}.git`
        : `Hob "${project}" does not exist`,
    )
  }
  if (!allowsProject(agent.access, project)) return plain(res, 403, `This key has no access to ${project}`)
  const push = mentionsReceivePack(rest, query)
  if (push && agent.access.readOnly) return plain(res, 403, 'This key can only read, so it cannot push')

  const header = (name: string) => {
    const value = req.headers[name]
    return Array.isArray(value) ? value.join(', ') : (value ?? '')
  }

  const backend = startGitBackend(host, {
    project,
    rest,
    query,
    method: req.method ?? 'GET',
    contentType: header('content-type'),
    contentLength: header('content-length'),
    gitProtocol: header('git-protocol'),
    contentEncoding: header('content-encoding'),
    remoteUser: agent.name,
    remoteAddress: remoteAddress ?? '',
    push,
  })
  req.pipe(backend.stdin)
  backend.stdin.on('error', () => {})
  backend.response.then(
    ({ status, headers, body }) => {
      res.writeHead(status, headers)
      body.pipe(res)
    },
    () => {
      if (!res.headersSent) plain(res, 500, 'git backend failed')
      else res.destroy()
    },
  )
}

export type GitBackendRequest = {
  project: string
  rest: string
  query: string
  method: string
  contentType: string
  contentLength: string
  gitProtocol: string
  contentEncoding: string
  remoteUser: string
  remoteAddress: string
  push: boolean
}

// Runs `git http-backend` for one request. Write the request body to `stdin`.
// Repos take pushes from VMs, so received objects are checked and the size of
// a push is limited.
export function startGitBackend(host: Host, request: GitBackendRequest) {
  const { project, rest, query, push } = request
  // Built from scratch rather than inherited, so nothing from the host process
  // (such as HOBWORK_ALLOW_MAIN) reaches the pre-receive hook.
  const env: Record<string, string> = gitEnv({
    GIT_PROJECT_ROOT: reposDir(host),
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${project}.git${rest}`,
    REQUEST_METHOD: request.method,
    QUERY_STRING: query,
    REMOTE_USER: request.remoteUser,
    REMOTE_ADDR: request.remoteAddress,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'receive.fsckObjects',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'receive.maxInputSize',
    GIT_CONFIG_VALUE_1: String(MAX_PUSH_BYTES),
  })
  const optional = {
    CONTENT_TYPE: request.contentType,
    CONTENT_LENGTH: request.contentLength,
    GIT_PROTOCOL: request.gitProtocol,
    HTTP_CONTENT_ENCODING: request.contentEncoding,
  }
  for (const [variable, value] of Object.entries(optional)) {
    if (value) env[variable] = value
  }

  const child = spawn('git', ['http-backend'], { env })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.on('close', (code) => {
    if (code !== 0) {
      console.error(`git http-backend exited with ${code}: ${Buffer.concat(stderr).toString('utf8')}`)
    }
    if (push && request.method === 'POST') publishChange(host.db, { kind: 'branches', project })
  })

  const response = new Promise<{ status: number; headers: Record<string, string>; body: Readable }>(
    (resolve, reject) => {
      child.on('error', (err) => {
        console.error('git http-backend failed to start', err)
        reject(err)
      })
      child.on('close', () => reject(new Error('git backend failed')))
      let head = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        const end = headerEnd(head)
        if (!end) return
        child.stdout.off('data', onData)
        const { status, headers } = parseCgiHeaders(head.subarray(0, end.index).toString('latin1'))
        const body = new PassThrough()
        body.write(head.subarray(end.index + end.length))
        child.stdout.pipe(body)
        resolve({ status, headers, body })
      }
      child.stdout.on('data', onData)
    },
  )
  response.catch(() => {})
  return { stdin: child.stdin, response }
}

function headerEnd(buffer: Buffer): { index: number; length: number } | undefined {
  const crlf = buffer.indexOf('\r\n\r\n')
  const lf = buffer.indexOf('\n\n')
  if (crlf === -1 && lf === -1) return undefined
  if (lf === -1 || (crlf !== -1 && crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

function parseCgiHeaders(text: string): { status: number; headers: Record<string, string> } {
  let status = 200
  const headers: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (name === 'status') status = Number.parseInt(value, 10) || 500
    else headers[name] = value
  }
  return { status, headers }
}
