import * as z from 'zod'
import type { FileRequest, FileResponse } from '../../packages/sdk/src/workspace-tools/files.ts'
import type { GitRequest, GitResponse } from '../../packages/sdk/src/workspace-tools/git.ts'
import { ProjectError } from './projects.ts'
import type { ExecWorkspaceVm } from './workspaces.ts'

// The file and git tools in packages/sdk/src/workspace-tools run in the
// workspace VM, so nothing on the host opens or runs git on files the VM can
// write. Everything they print is untrusted: it is read up to a size limit and
// checked against these schemas before the host uses it.

export const TOOL_COMMAND = 'hobwork-tool'

const MAX_OUTPUT_CHARS = 12 * 1024 * 1024
const MAX_ERROR_CHARS = 2000
const MAX_TEXT = 8 * 1024 * 1024

const text = (max = MAX_TEXT) => z.string().max(max)
const sha = z.string().regex(/^[0-9a-f]{40}$/)

const fileResponse = z.union([
  z.object({ op: z.literal('read'), binary: z.literal(false), content: text(), size: z.number().int().min(0) }),
  z.object({ op: z.literal('read'), binary: z.literal(true), size: z.number().int().min(0) }),
  z.object({ op: z.literal('write'), created: z.boolean() }),
  z.object({ op: z.literal('edit'), replacements: z.number().int().min(1) }),
  z.object({ op: z.literal('delete') }),
  z.object({ op: z.literal('list'), entries: z.array(text(4096)).max(2000), truncated: z.boolean() }),
  z.object({
    op: z.literal('search'),
    matches: z.array(text(4096)).max(500),
    truncated: z.boolean(),
    filesSearched: z.number().int().min(0),
  }),
  z.object({
    op: z.literal('migrations'),
    files: z.array(z.object({ name: z.string().max(255), sql: text(1024 * 1024) })).max(1000),
  }),
])

const gitResponse = z.union([
  z.object({ op: z.literal('commit'), committed: z.literal(false) }),
  z.object({ op: z.literal('commit'), committed: z.literal(true), sha, clean: z.boolean() }),
  z.object({ op: z.literal('diff'), diff: text(2 * 1024 * 1024), truncated: z.boolean() }),
  z.object({ op: z.literal('changes'), lines: z.array(text(4096)).max(1000), total: z.number().int().min(0) }),
  z.object({ op: z.literal('state'), head: sha, clean: z.boolean() }),
  z.object({ op: z.literal('reset') }),
])

const envelope = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: text(MAX_ERROR_CHARS * 2) }),
])

export type ToolOptions = {
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

async function runTool(
  vm: Pick<ExecWorkspaceVm, 'exec'>,
  tool: 'files' | 'git',
  request: { op: string },
  options: ToolOptions,
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const overflow = new AbortController()
  const signals = [overflow.signal, AbortSignal.timeout(timeoutMs)]
  if (options.signal) signals.push(options.signal)
  const signal = AbortSignal.any(signals)
  let stdout = ''
  const result = await vm.exec(`${TOOL_COMMAND} ${tool}`, {
    cwd: '.',
    timeoutMs,
    signal,
    env: options.env,
    input: JSON.stringify(request),
    onOutput: (stream, chunk) => {
      if (stream !== 'stdout') return
      stdout += chunk
      if (stdout.length > MAX_OUTPUT_CHARS) overflow.abort()
    },
  })
  if (overflow.signal.aborted) throw new ProjectError('The workspace returned too much data')
  if (options.signal?.aborted) throw new ProjectError('The request was cancelled')
  if (signal.aborted) throw new ProjectError(`The workspace did not answer within ${timeoutMs / 1000}s`)

  let parsed
  try {
    parsed = envelope.parse(JSON.parse(stdout))
  } catch {
    const detail = result.stderr.trim().slice(0, MAX_ERROR_CHARS)
    throw new ProjectError(`The workspace tool failed (exit code ${result.exitCode})${detail ? `: ${detail}` : ''}`)
  }
  if (!parsed.ok) throw new ProjectError(parsed.error.slice(0, MAX_ERROR_CHARS))
  return parsed.result
}

function checked<T extends { op: string }>(schema: z.ZodType<T>, request: { op: string }, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success || parsed.data.op !== request.op) {
    throw new ProjectError('The workspace tool returned an unexpected answer')
  }
  return parsed.data
}

export async function runFileTool<R extends FileRequest>(
  vm: Pick<ExecWorkspaceVm, 'exec'>,
  request: R,
  options: ToolOptions = {},
): Promise<Extract<FileResponse, { op: R['op'] }>> {
  return checked(fileResponse, request, await runTool(vm, 'files', request, options)) as Extract<FileResponse, { op: R['op'] }>
}

export async function runGitTool<R extends GitRequest>(
  vm: Pick<ExecWorkspaceVm, 'exec'>,
  request: R,
  options: ToolOptions = {},
): Promise<Extract<GitResponse, { op: R['op'] }>> {
  return checked(gitResponse, request, await runTool(vm, 'git', request, options)) as Extract<GitResponse, { op: R['op'] }>
}
