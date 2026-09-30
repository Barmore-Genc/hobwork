// Runs as root through doas (see guest-vm.ts) and is the only thing in a
// workspace VM that holds session tokens. It forwards requests to the host's
// internal API with the token of the command that the calling process belongs
// to, found by walking up its parents to a process that has a registered
// session. A process that outlived its command has no such parent, and one
// that never had a session cannot learn a token.
//
// Protocol: JSON lines on stdin, `{ id, method, path, body? }`, answered on
// stdout with `{ id, status, body }`. It exits when stdin closes.
import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { request } from 'node:http'
import { createInterface } from 'node:readline'

const SESSIONS_DIR = '/run/hobwork/sessions'
const BASE_URL = 'http://hobwork.internal'
const ALLOWED_PATHS = [/^\/v1\/workspace\/[a-z]+$/, /^\/v1\/(?:db|ha|devices)$/]
const MAX_DEPTH = 64

type BrokerRequest = { id: number; method: string; path: string; body?: string }

function processStat(pid: number): { parent: number; start: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The command name can contain spaces and parentheses, so fields count from the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { parent: Number(fields[1]), start: fields[19]! }
  } catch {
    return undefined
  }
}

// An entry is `<start time>\n<token>` in a file named after the command's process. The
// start time tells a reused process ID from the original process.
function tokenOf(pid: number): string | undefined {
  let entry: string
  try {
    entry = readFileSync(`${SESSIONS_DIR}/${pid}`, 'utf8')
  } catch {
    return undefined
  }
  const [start, token] = entry.split('\n')
  return start !== undefined && token && processStat(pid)?.start === start ? token : undefined
}

function sessionToken(from: number): string | undefined {
  let pid = from
  for (let depth = 0; pid > 1 && depth < MAX_DEPTH; depth++) {
    const token = tokenOf(pid)
    if (token) return token
    const stat = processStat(pid)
    if (!stat) return undefined
    pid = stat.parent
  }
  return undefined
}

function sweep(): void {
  let names: string[]
  try {
    names = readdirSync(SESSIONS_DIR)
  } catch {
    return
  }
  for (const name of names) {
    if (/^\d+$/.test(name) && !tokenOf(Number(name))) {
      try {
        unlinkSync(`${SESSIONS_DIR}/${name}`)
      } catch {}
    }
  }
}

function forward({ method, path, body }: BrokerRequest, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, BASE_URL),
      { method, headers: { 'x-hobwork-session': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

const NO_SESSION = {
  status: 401,
  body: JSON.stringify({ error: 'hobwork only works in commands started over SSH or with the bash tool' }),
}

async function handle(message: BrokerRequest, owner: number): Promise<{ status: number; body: string }> {
  if (!['GET', 'POST'].includes(message.method) || !ALLOWED_PATHS.some((pattern) => pattern.test(message.path.split('?')[0]!))) {
    return { status: 404, body: JSON.stringify({ error: `${message.method} ${message.path} is not available here` }) }
  }
  const token = sessionToken(owner)
  if (!token) return NO_SESSION
  try {
    return await forward(message, token)
  } catch (err) {
    return { status: 502, body: JSON.stringify({ error: `The host could not be reached: ${(err as Error).message}` }) }
  }
}

// doas starts this process with the caller as its parent. The parent is what
// authorizes requests, so nothing the caller says names a session.
const owner = process.ppid
sweep()

const pending = new Set<Promise<void>>()
createInterface({ input: process.stdin }).on('line', (line) => {
  let message: BrokerRequest
  try {
    message = JSON.parse(line) as BrokerRequest
    if (typeof message.id !== 'number' || typeof message.method !== 'string' || typeof message.path !== 'string') throw new Error()
  } catch {
    return
  }
  // A caller that died and was replaced as parent by init has nothing to act for.
  const alive = processStat(process.pid)?.parent === owner
  const task = (alive ? handle(message, owner) : Promise.resolve(NO_SESSION)).then((reply) => {
    process.stdout.write(`${JSON.stringify({ id: message.id, ...reply })}\n`)
  })
  pending.add(task)
  void task.finally(() => pending.delete(task))
}).on('close', () => {
  void Promise.all(pending).then(() => process.exit(0))
})
