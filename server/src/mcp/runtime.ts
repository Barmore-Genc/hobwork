import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import type { AppTarget } from '../apps/origins.ts'
import type { Host } from '../host.ts'
import { DEFAULT_BRANCH, ProjectError, requireProject } from '../projects.ts'
import { branchExists } from '../repo.ts'
import {
  ALL_BRANCHES,
  branchFilter,
  getInvocation,
  lastLogId,
  listInvocations,
  LOG_LEVELS,
  queryLogs,
  waitForLogs,
  type InvocationRecord,
  type LogEntry,
} from '../runtime/logs.ts'
import { matchRoute } from '../runtime/routes.ts'
import type { InvokeOutcome, Runtime } from '../runtime/runtime.ts'
import { rotateUploadToken, uploadFilesUrl } from '../runtime/uploads.ts'
import { HOOKS_PREFIX, rotateBranchWebhookToken, rotateWebhookToken, webhookUrl } from '../runtime/webhooks.ts'
import { MAX_OUTPUT_CHARS, truncateMiddle } from './output.ts'

const RESPONSE_BODY_CHARS = 10_000
const INVOCATION_LOG_LINES = 200
const MAX_TAIL_SECONDS = 60

const hob = z.string().describe('Hob name, e.g. "filament-tracker"')
const kind = z.enum(['route', 'cron', 'webhook', 'trigger'])
const branch = z.string().optional().describe(`Branch to run as a preview (its latest commit). Omit, or "${DEFAULT_BRANCH}", for the deployed version`)
const branchShown = z
  .string()
  .optional()
  .describe(`Whose records to show: omit, or "${DEFAULT_BRANCH}", for the deployed version; a branch name for its previews; "${ALL_BRANCHES}" for all`)

function previewBranch(value: string | undefined): string | undefined {
  return value === undefined || value === DEFAULT_BRANCH ? undefined : value
}

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) }
}

export function formatInvocation(i: InvocationRecord): string {
  const duration = i.durationMs === null ? '' : ` ${i.durationMs}ms`
  const http = i.httpStatus === null ? '' : ` HTTP ${i.httpStatus}`
  const error = i.error ? `: ${i.error.split('\n')[0]}` : ''
  const where = i.branch === null ? `v${i.version ?? '?'}` : `branch ${i.branch}`
  return `#${i.id} ${i.startedAt} ${i.kind} "${i.name}" ${where}${i.manual ? ' (manual)' : ''} ${i.status}${duration}${http}${error}`
}

function formatLine(line: LogEntry): string {
  const tags = [
    line.source,
    line.event,
    line.branch === null ? null : `branch ${line.branch}`,
    line.invocationId === null ? null : `invocation ${line.invocationId}`,
  ]
    .filter(Boolean)
    .join(' ')
  const [first, ...rest] = line.message.split('\n')
  return [`#${line.id} ${line.time} ${line.level.toUpperCase()} [${tags}] ${first}`, ...rest.map((l) => `    ${l}`)].join('\n')
}

// Keeps whole lines from the start so the cursor stays meaningful: the caller
// continues after the last line shown.
export function formatLines(lines: LogEntry[], budget = MAX_OUTPUT_CHARS): { text: string; shown: number; cursor?: number } {
  const out: string[] = []
  let size = 0
  let cursor: number | undefined
  for (const line of lines) {
    const formatted = formatLine(line)
    if (out.length && size + formatted.length > budget) break
    out.push(formatted.length > budget ? truncateMiddle(formatted, budget) : formatted)
    size += formatted.length + 1
    cursor = line.id
  }
  return { text: out.join('\n'), shown: out.length, cursor }
}

function formatBody(base64: string): string {
  const body = Buffer.from(base64, 'base64')
  if (!body.length) return '(empty body)'
  if (body.subarray(0, 8000).includes(0)) return `(${body.length} bytes of binary data)`
  return truncateMiddle(body.toString('utf8'), RESPONSE_BODY_CHARS)
}

function formatOutcome(host: Host, projectName: string, label: string, outcome: InvokeOutcome): CallToolResult {
  const lines = [
    `Invocation ${outcome.invocationId} (${label}): ${outcome.ok ? 'ok' : 'error'} in ${outcome.durationMs}ms`,
  ]
  if (outcome.ok) {
    const { status, headers, body } = outcome.response
    lines.push(`HTTP ${status}`, ...headers.map(([k, v]) => `${k}: ${v}`), '', formatBody(body))
  } else {
    lines.push(outcome.error.stack ?? `${outcome.error.name}: ${outcome.error.message}`)
  }
  const logs = queryLogs(host, { project: projectName, invocationId: outcome.invocationId, limit: INVOCATION_LOG_LINES })
  lines.push('', logs.length ? `Logs:\n${formatLines(logs, MAX_OUTPUT_CHARS / 2).text}` : 'No log lines.')
  return text(truncateMiddle(lines.join('\n')), !outcome.ok)
}

export function registerRuntimeTools(
  server: McpServer,
  { host, runtime, appOrigin }: { host: Host; runtime?: Runtime; appOrigin?: (target: AppTarget) => string | undefined },
) {
  const originOf = (target: AppTarget): string => {
    const origin = appOrigin?.(target)
    if (!origin) throw new ProjectError(`${target.project} has no app address: ${appOrigin ? 'the hob name is too long for branch previews' : 'this Hobwork host does not serve apps'}`)
    return origin
  }

  server.registerTool(
    'invoke',
    {
      description: `Run a handler now and return its result, error with stack trace, and log lines: of the deployed version (${DEFAULT_BRANCH}), or with branch, of a preview of that branch's latest commit (committed changes only), built on first use. A preview uses the branch DB, reads Home Assistant states, and calls HA services or fires events only when that is allowed for the branch (set_branch_home_assistant, or the user on the hob page); otherwise those calls fail with code not_approved. The invocation is recorded like any other (marked manual, with the branch). Routes: name is the method and path to request, e.g. "GET /spools/42?full=1", matched against the routes in hobwork.json. Webhooks: name is the webhook name; the request is sent without needing its token. Crons and triggers: name from hobwork.json; payload is passed as ctx.payload (for Home Assistant triggers, HA's trigger variables). Branch crons and triggers never run on their own, only through invoke.`,
      inputSchema: {
        hob,
        kind,
        branch,
        name: z.string().describe('Route "METHOD /path", or the cron, webhook or trigger name'),
        body: z.string().optional().describe('Request body for routes and webhooks'),
        headers: z.record(z.string(), z.string()).optional().describe('Request headers for routes and webhooks'),
        method: z.string().default('POST').describe('HTTP method for webhooks'),
        payload: z.unknown().optional().describe('ctx.payload for crons and triggers'),
      },
    },
    async ({ hob: p, kind: k, branch: rawBranch, name, body, headers, method, payload }) => {
      requireProject(host, p)
      if (!runtime?.canRun) {
        throw new ProjectError('This Hobwork host cannot run handlers: no runtime VM backend is configured')
      }
      const b = previewBranch(rawBranch)
      if (b !== undefined && !(await branchExists(host, p, b))) throw new ProjectError(`Branch "${b}" does not exist in ${p}`)
      const where = (outcome: InvokeOutcome) => (b === undefined ? `version ${outcome.version ?? '?'}` : `branch ${b}`)
      const requestOf = (httpMethod: string, path: string) => ({
        method: httpMethod,
        url: `http://localhost${path}`,
        headers: Object.entries(headers ?? {}).map(([n, v]) => [n.toLowerCase(), v] as [string, string]),
        ...(body === undefined ? {} : { body: Buffer.from(body).toString('base64') }),
      })
      if (k === 'route') {
        const match = /^([A-Za-z]+)\s+(\/\S*)$/.exec(name.trim())
        if (!match) throw new ProjectError('For routes, name is the method and path to request, e.g. "GET /spools"')
        const [, httpMethod = 'GET', target = '/'] = match
        const path = target.split('?')[0] ?? '/'
        const { routes } = await runtime.route(p, b)
        const found = matchRoute(routes, httpMethod, path)
        if (!found || 'methodNotAllowed' in found) {
          const keys = routes.map((r) => r.key)
          throw new ProjectError(
            `No route in ${p} matches ${httpMethod.toUpperCase()} ${path}. ${keys.length ? `Routes: ${keys.join(', ')}` : 'It has no routes'}`,
          )
        }
        const outcome = await runtime.invoke(p, {
          kind: 'route',
          name: found.route.key,
          manual: true,
          branch: b,
          request: requestOf(httpMethod.toUpperCase(), `/api${target}`),
          params: found.params,
        })
        return formatOutcome(host, p, `route "${found.route.key}", ${where(outcome)}`, outcome)
      }
      const hook = `${HOOKS_PREFIX}${name}`
      const outcome = await runtime.invoke(p, {
        kind: k,
        name,
        manual: true,
        branch: b,
        ...(k === 'webhook' ? { request: requestOf(method.toUpperCase(), hook) } : { payload }),
      })
      return formatOutcome(host, p, `${k} "${name}", ${where(outcome)}`, outcome)
    },
  )

  server.registerTool(
    'list_invocations',
    {
      description:
        'List recorded invocations of a hob, newest first: ID, start time, kind and name, version (or branch, for previews), status, duration, HTTP status and the first line of the error. Use get_logs with an invocation_id for its log lines and full stack trace.',
      inputSchema: {
        hob,
        branch: branchShown,
        kind: kind.optional(),
        name: z.string().optional().describe('Route key ("GET /spools") or cron, webhook or trigger name'),
        status: z.enum(['running', 'ok', 'error']).optional(),
        version: z.number().int().optional(),
        before_id: z.number().int().optional().describe('Only invocations older than this ID, for paging'),
        limit: z.number().int().min(1).max(200).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ hob: p, branch: b, kind: k, name, status, version, before_id, limit }) => {
      requireProject(host, p)
      const found = listInvocations(host, {
        project: p,
        branch: branchFilter(b),
        kind: k,
        name,
        status,
        version,
        beforeId: before_id,
        limit,
      })
      if (!found.length) return text('No invocations match')
      const more = found.length === limit ? `\n[More may exist: page with before_id ${found.at(-1)!.id}]` : ''
      return text(truncateMiddle(found.map(formatInvocation).join('\n') + more))
    },
  )

  server.registerTool(
    'get_logs',
    {
      description:
        'Read the log store of a hob, oldest first: handler output (console and ctx.log, per invocation), runtime events (start, stop, crash, deploy, auto-revert, blocked egress) and pipeline step results. Shows the deployed version\'s lines unless branch says otherwise. With invocation_id, shows all lines of that invocation, on any branch, with its record, error and full stack trace. Without a starting point (after_id, since, invocation_id), shows the latest lines. Each line starts with its ID; pass the last one as after_id to continue.',
      inputSchema: {
        hob,
        branch: branchShown,
        invocation_id: z.number().int().optional(),
        after_id: z.number().int().optional().describe('Only lines after this log line ID'),
        since: z.string().optional().describe('ISO time, e.g. "2026-01-31T08:00:00Z"'),
        until: z.string().optional().describe('ISO time'),
        source: z.enum(['handler', 'runtime', 'pipeline']).optional(),
        min_level: z.enum(LOG_LEVELS as [string, ...string[]]).optional(),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ hob: p, branch: b, invocation_id, after_id, since, until, source, min_level, limit }) => {
      requireProject(host, p)
      const toIso = (value: string | undefined, field: string) => {
        if (value === undefined) return undefined
        const time = Date.parse(value)
        if (Number.isNaN(time)) throw new ProjectError(`${field} must be an ISO time, got "${value}"`)
        return new Date(time).toISOString()
      }
      const parts: string[] = []
      if (invocation_id !== undefined) {
        const invocation = getInvocation(host, invocation_id)
        if (!invocation || invocation.project !== p) throw new ProjectError(`Invocation ${invocation_id} does not exist in ${p}`)
        parts.push(formatInvocation(invocation))
        if (invocation.stack) parts.push(invocation.stack)
        parts.push('')
      }
      const lines = queryLogs(host, {
        project: p,
        branch: invocation_id === undefined ? branchFilter(b) : undefined,
        invocationId: invocation_id,
        afterId: after_id,
        since: toIso(since, 'since'),
        until: toIso(until, 'until'),
        source,
        minLevel: min_level as (typeof LOG_LEVELS)[number] | undefined,
        limit,
      })
      const formatted = formatLines(lines, MAX_OUTPUT_CHARS - parts.join('\n').length)
      parts.push(formatted.text || 'No log lines match')
      if (formatted.cursor !== undefined && (formatted.shown < lines.length || lines.length === limit)) {
        parts.push(`[More lines may follow: continue with after_id ${formatted.cursor}]`)
      }
      return text(truncateMiddle(parts.join('\n')))
    },
  )

  server.registerTool(
    'tail_logs',
    {
      description:
        'Wait for new log lines of a hob and return them as soon as there are any: the deployed version\'s unless branch or invocation_id says otherwise. Returns a cursor; pass it to the next call to continue where this one ended. Without a cursor, only lines logged after the call starts are returned. Use it while triggering a handler, e.g. after asking the user to press a button.',
      inputSchema: {
        hob,
        cursor: z.number().int().optional().describe('Log line ID from a previous get_logs or tail_logs call'),
        branch: branchShown,
        invocation_id: z.number().int().optional(),
        wait_seconds: z.number().int().min(0).max(MAX_TAIL_SECONDS).default(30),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ hob: p, cursor, branch: b, invocation_id, wait_seconds, limit }, extra) => {
      const shown = invocation_id === undefined ? branchFilter(b) : undefined
      requireProject(host, p)
      let after = cursor ?? lastLogId(host, p)
      const deadline = Date.now() + wait_seconds * 1000
      for (;;) {
        const lines = queryLogs(host, { project: p, branch: shown, afterId: after, invocationId: invocation_id, limit })
        if (lines.length) {
          const formatted = formatLines(lines)
          after = formatted.cursor ?? after
          return text(`${formatted.text}\n[cursor: ${after}]`)
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0 || extra.signal.aborted) return text(`No new log lines in ${wait_seconds}s.\n[cursor: ${after}]`)
        await waitForLogs(p, remaining, extra.signal)
      }
    },
  )

  server.registerTool(
    'rotate_webhook_token',
    {
      description:
        'Create or replace the secret token of a webhook and return its full URL (<hob app origin>/_hobwork/hooks/<name>/<token>): webhooks are called on the hob\'s own app address, not on the Hobwork address. With branch, the URL is on that branch\'s preview origin and calls the preview instead, with its own token. The token is shown only now; rotating again invalidates the old URL right away. A webhook without a token cannot be called from outside.',
      inputSchema: {
        hob,
        webhook: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('Webhook name from hobwork.json'),
        branch,
      },
      annotations: { destructiveHint: true },
    },
    async ({ hob: p, webhook, branch: rawBranch }) => {
      const b = previewBranch(rawBranch)
      if (b === undefined) {
        const origin = originOf({ project: p })
        const token = rotateWebhookToken(host, p, webhook)
        return text(`Webhook URL: ${webhookUrl(origin, webhook, token)}\nAny HTTP method works.`)
      }
      if (!(await branchExists(host, p, b))) throw new ProjectError(`Branch "${b}" does not exist in ${p}`)
      const origin = originOf({ project: p, branch: b })
      const token = rotateBranchWebhookToken(host, p, b, webhook)
      return text(`Webhook URL for branch ${b}: ${webhookUrl(origin, webhook, token)}\nAny HTTP method works. It runs the branch's latest commit.`)
    },
  )

  server.registerTool(
    'rotate_upload_token',
    {
      description:
        'Create or replace the token that lets scripts store files through an upload of hobwork.json ("uploads"), and return it with the URL to PUT files to. A script sends each file as `curl -T <file> -H "Authorization: Bearer <token>" <url><name>`; the path after the URL must stay under the upload\'s prefix. Only the deployed version takes token uploads. The token is shown only now; rotating again invalidates the old one right away.',
      inputSchema: {
        hob,
        upload: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe('Upload name from hobwork.json'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ hob: p, upload }) => {
      const entry = (await runtime?.config(p))?.config.uploads[upload]
      if (!entry) throw new ProjectError(`The deployed version of ${p} has no upload called "${upload}"`)
      const token = rotateUploadToken(host, p, upload)
      return text(`Upload token: ${token}\nPUT files to: ${uploadFilesUrl(originOf({ project: p }), entry.prefix)}<name>`)
    },
  )
}
