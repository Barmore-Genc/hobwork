// The `hobwork` command in workspace VMs. The host mounts this directory into
// every workspace VM; calls go to the VM's own handler at hobwork.internal,
// which knows the project and branch. HOBWORK_SESSION names the agent.
import { request } from 'node:http'

const BASE_URL = process.env.HOBWORK_INTERNAL_URL ?? 'http://hobwork.internal'
const FOLLOW_WAIT_SECONDS = 25

const USAGE = `Usage: hobwork <command>

  status                 branch, uncommitted changes, deployed version, last pipeline run
  diff                   uncommitted changes
  commit "<message>"     commit all changes and push them to the branch
  merge "<summary>"      run the pipeline, merge into main and deploy
  logs [-f] [-n <lines>] project logs; -f keeps printing new lines
  invocations [-n <count>]  recent handler invocations
  sql "<statement>"      run one SQL statement on the branch DB, a copy of the
                         production DB taken when the workspace VM started
  ha state <entity_id>   a Home Assistant entity's state and attributes
  ha states [<domain>]   every entity's state, or those of one domain (light, sensor, ...)`

type CliResult = { output: string; ok: boolean; cursor?: number }

class UsageError extends Error {}

// node:http instead of fetch: merges can take longer than fetch's 5 minute
// header timeout.
function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<CliResult> {
  const session = process.env.HOBWORK_SESSION
  if (!session) {
    throw new Error('HOBWORK_SESSION is not set. Run hobwork in an SSH session or with the bash tool.')
  }
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      new URL(path, BASE_URL),
      {
        method,
        headers: {
          'x-hobwork-session': session,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            return reject(new Error(`The host answered HTTP ${res.statusCode}: ${text.slice(0, 500)}`))
          }
          const { error } = parsed as { error?: string }
          if (res.statusCode !== 200) return reject(new Error(error ?? `The host answered HTTP ${res.statusCode}`))
          resolve(parsed as CliResult)
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

function count(args: string[], fallback: number): number {
  const i = args.indexOf('-n')
  if (i === -1) return fallback
  const value = Number(args[i + 1])
  if (!Number.isSafeInteger(value) || value < 1) throw new UsageError('-n needs a positive number')
  return value
}

function text(args: string[], what: string): string {
  const value = args.filter((a) => a !== '-m').join(' ').trim()
  if (!value) throw new UsageError(`Give a ${what}`)
  return value
}

function print(result: CliResult): void {
  if (result.output) process.stdout.write(result.output.endsWith('\n') ? result.output : `${result.output}\n`)
  if (!result.ok) process.exitCode = 1
}

// The branch DB answers like ctx.db does in a handler.
async function sql(statement: string): Promise<void> {
  const res = await fetch(new URL('/v1/db', BASE_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ statements: [{ sql: statement }], transaction: false }),
  })
  const body = (await res.json().catch(() => undefined)) as
    | { ok: true; results: { rows: unknown[]; changes: number }[] }
    | { ok: false; error: { message: string } }
    | { error?: string }
    | undefined
  if (!body || !('ok' in body)) throw new Error(body?.error ?? `The host answered HTTP ${res.status}`)
  if (!body.ok) throw new Error(body.error.message)
  const [result] = body.results
  if (result?.rows.length) process.stdout.write(`${result.rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  else process.stdout.write(result?.changes ? `${result.changes} rows changed\n` : 'No rows\n')
}

// Workspaces read Home Assistant like ctx.ha does in a handler; service calls
// only run from deployed handlers.
async function ha(args: string[]): Promise<void> {
  const [what, arg] = args
  let request: object
  if (what === 'state' && arg) request = { action: 'getState', entityId: arg }
  else if (what === 'states') request = { action: 'getStates', filter: arg ? { domain: arg } : undefined }
  else throw new UsageError(what === 'state' ? 'Give an entity ID' : `Unknown ha command "${what ?? ''}"`)
  const res = await fetch(new URL('/v1/ha', BASE_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const body = (await res.json().catch(() => undefined)) as
    | { ok: true; result: unknown }
    | { ok: false; error: { message: string } }
    | { error?: string }
    | undefined
  if (!body || !('ok' in body)) throw new Error(body?.error ?? `The host answered HTTP ${res.status}`)
  if (!body.ok) throw new Error(body.error.message)
  if (body.result === null) throw new Error(`${arg} does not exist`)
  process.stdout.write(`${JSON.stringify(body.result, null, 2)}\n`)
}

async function followLogs(lines: number): Promise<void> {
  let result = await call('GET', `/v1/workspace/logs?limit=${lines}`)
  for (;;) {
    print(result)
    result = await call('GET', `/v1/workspace/logs?after=${result.cursor ?? 0}&wait=${FOLLOW_WAIT_SECONDS}&limit=1000`)
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv
  switch (command) {
    case 'status':
      return print(await call('GET', '/v1/workspace/status'))
    case 'diff':
      return print(await call('GET', '/v1/workspace/diff'))
    case 'commit':
      return print(await call('POST', '/v1/workspace/commit', { message: text(args, 'commit message') }))
    case 'merge':
      return print(await call('POST', '/v1/workspace/merge', { summary: text(args, 'summary of the change') }))
    case 'logs':
      if (args.includes('-f')) return followLogs(count(args, 20))
      return print(await call('GET', `/v1/workspace/logs?limit=${count(args, 50)}`))
    case 'sql':
      return sql(text(args, 'SQL statement'))
    case 'ha':
      return ha(args)
    case 'invocations':
      return print(await call('GET', `/v1/workspace/invocations?limit=${count(args, 20)}`))
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(`${USAGE}\n`)
      return
    default:
      throw new UsageError(`Unknown command "${command}"`)
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof UsageError) process.stderr.write(`${err.message}\n\n${USAGE}\n`)
  else process.stderr.write(`hobwork: ${(err as Error).message}\n`)
  process.exitCode = err instanceof UsageError ? 2 : 1
})
