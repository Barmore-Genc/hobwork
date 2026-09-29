import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { allowsProject } from './access.ts'
import { verifyAgentToken, type AuthenticatedAgent } from './agents.ts'
import { gitEnv } from './git.ts'
import { reposDir, type Host } from './host.ts'
import { getProject, renamedProject } from './projects.ts'

export const GIT_PREFIX = '/git/'

const GIT_PATH = /^\/git\/([a-z0-9-]+)\.git(\/[A-Za-z0-9._/-]*)$/

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

export function handleGit(host: Host, req: IncomingMessage, res: ServerResponse, pathname: string, query: string) {
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
        ? `Project "${project}" was renamed to "${renamed.name}". Change the remote URL to ${GIT_PREFIX}${renamed.name}.git`
        : `Project "${project}" does not exist`,
    )
  }
  if (!allowsProject(agent.access, project)) return plain(res, 403, `This key has no access to ${project}`)
  const push = rest === '/git-receive-pack' || new URLSearchParams(query).get('service') === 'git-receive-pack'
  if (push && agent.access.readOnly) return plain(res, 403, 'This key can only read, so it cannot push')

  const header = (name: string) => {
    const value = req.headers[name]
    return Array.isArray(value) ? value.join(', ') : (value ?? '')
  }

  // Built from scratch rather than inherited, so nothing from the host process
  // (such as HOBWORK_ALLOW_MAIN) reaches the pre-receive hook.
  const env: Record<string, string> = gitEnv({
    GIT_PROJECT_ROOT: reposDir(host),
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${project}.git${rest}`,
    REQUEST_METHOD: req.method ?? 'GET',
    QUERY_STRING: query,
    REMOTE_USER: agent.name,
    REMOTE_ADDR: req.socket.remoteAddress ?? '',
  })
  const optional = {
    CONTENT_TYPE: 'content-type',
    CONTENT_LENGTH: 'content-length',
    GIT_PROTOCOL: 'git-protocol',
    HTTP_CONTENT_ENCODING: 'content-encoding',
  }
  for (const [variable, name] of Object.entries(optional)) {
    const value = header(name)
    if (value) env[variable] = value
  }

  const child = spawn('git', ['http-backend'], { env })
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.on('error', (err) => {
    console.error('git http-backend failed to start', err)
    if (!res.headersSent) plain(res, 500, 'git backend failed')
    else res.destroy()
  })
  child.on('close', (code) => {
    if (code !== 0) {
      console.error(`git http-backend exited with ${code}: ${Buffer.concat(stderr).toString('utf8')}`)
    }
    if (!res.headersSent) plain(res, 500, 'git backend failed')
  })

  req.pipe(child.stdin)
  child.stdin.on('error', () => {})

  let head = Buffer.alloc(0)
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk])
    const end = headerEnd(head)
    if (!end) return
    child.stdout.off('data', onData)
    const { status, headers } = parseCgiHeaders(head.subarray(0, end.index).toString('latin1'))
    res.writeHead(status, headers)
    res.write(head.subarray(end.index + end.length))
    child.stdout.pipe(res)
  }
  child.stdout.on('data', onData)
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
