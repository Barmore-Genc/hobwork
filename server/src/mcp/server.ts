import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { parseHobworkJson } from '../../../packages/sdk/src/hobwork-json.js'
import { allowsProject } from '../access.ts'
import type { AuthenticatedAgent } from '../agents.ts'
import type { AppTarget } from '../apps/origins.ts'
import type { ProjectData } from '../data/project-data.ts'
import type { Delivery } from '../delivery.ts'
import type { Devices } from '../devices/devices.ts'
import {
  checkoutDirectory,
  deleteCheckoutFile,
  editCheckoutFile,
  listCheckoutFiles,
  readCheckoutFile,
  searchCheckout,
  writeCheckoutFile,
} from '../files.ts'
import type { HomeAssistant } from '../homeassistant/client.ts'
import type { Host } from '../host.ts'
import type { Runtime } from '../runtime/runtime.ts'
import type { SecretStore } from '../secrets.ts'
import type { StorageUsage } from '../storage.ts'
import { createProject, DEFAULT_BRANCH, listProjects, ProjectError, requireProject } from '../projects.ts'
import { createBranch, diffBranch, listBranches, log, readFileAtRef } from '../repo.ts'
import type { ExecWorkspaceVm, WorkspaceManager } from '../workspaces.ts'
import { limitTools } from './access.ts'
import { runBash } from './bash.ts'
import { registerBranchHaTools } from './branch-ha.ts'
import { registerDeliveryTools } from './delivery.ts'
import { registerDeviceTools } from './devices.ts'
import { registerHomeAssistantTools } from './homeassistant.ts'
import { MAX_OUTPUT_CHARS, truncateMiddle } from './output.ts'
import { registerRuntimeTools } from './runtime.ts'
import { registerSecretTools } from './secrets.ts'
import { registerSshKeyTools, type SshAddress } from './ssh-keys.ts'

export type McpContext = {
  host: Host
  workspaces: WorkspaceManager<ExecWorkspaceVm>
  delivery: Delivery
  agent: AuthenticatedAgent
  // Origin of the web UI, for links agents show the user.
  publicUrl: string
  ssh?: SshAddress
  homeAssistant?: HomeAssistant
  runtime?: Runtime
  data?: ProjectData
  secrets?: SecretStore
  storage?: StorageUsage
  devices?: Devices
  appOrigin?: (target: AppTarget) => string | undefined
}

export const INSTRUCTIONS = `Hobwork runs a household's automations: scripts, scheduled jobs, HTTP routes, webhooks and small dashboards. Each project is a git repository. The main branch is the deployed version and changes only by merging another branch.

Before changing a project, read its AGENTS.md (read_file on main or on your branch). It explains the layout, the SDK and the workflow.

Workflow: create a branch, change files on it (write_file, edit_file), run checks in the branch workspace with bash (pnpm typecheck, pnpm lint, pnpm test), then commit. File changes stay in the branch workspace until you commit. When the change is done, merge the branch with a summary: this runs the pipeline and deploys the change as a new version, or returns the failing step's output.

Rules:
- Handlers are like AWS Lambda functions. Nothing in memory survives between invocations. Store state in the project DB through the SDK.
- There are no long-running processes. Use a cron for recurring work.
- Every change needs tests. Merging runs typecheck, lint, tests and build, and refuses on failure.
- Migrations are forward-only and additive: add tables and columns, never drop or rename them, so older versions keep working after a restore.
- Debug from logs and invocation records. Do not guess.
- When a project uses Home Assistant, read data Home Assistant already has (states, history, device details) from it instead of copying it into the project DB. Store a copy only when the user asks for one or the feature cannot work without it.
- Only people can delete, rename or restore a project, in the Hobwork web UI. There are no tools for it.
- Only the user creates secrets and sets their values, in the Hobwork UI. When a project needs one, look for it with list_secrets and assign it to the project with assign_secret. If it does not exist, ask the user to create it in Hobwork, then assign it. A secret is only sent to its hosts: if it has none or lacks one, ask for them with request_secret_hosts and show the user the link it returns. Handlers read it as ctx.secrets.<env name>.
- Prefer the platform packages (React, Tailwind, Vite, Vitest, TypeScript, oxlint, zod, date-fns). Add another npm package only when none of them does the job.`

const MAX_READ_LINES = 2000
const DEFAULT_BASH_TIMEOUT_SECONDS = 120
const MAX_BASH_TIMEOUT_SECONDS = 600

const project = z.string().describe('Project name, e.g. "filament-tracker"')
const branch = z
  .string()
  .describe(`Branch name. ${DEFAULT_BRANCH} can be read but not changed; make changes on another branch`)
const writableBranch = z
  .string()
  .describe(`Branch to change. Must not be ${DEFAULT_BRANCH}; create a branch with create_branch first`)
const filePath = z.string().describe('File path relative to the project root, e.g. "src/scan.ts"')

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2))
}

function formatReadResult(content: string, offset: number, limit: number): string {
  if (!content) return '(empty file)'
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const start = offset - 1
  if (start >= lines.length) {
    throw new ProjectError(`offset ${offset} is past the end of the file (${lines.length} lines)`)
  }
  const shown = lines.slice(start, start + limit)
  let body = shown.join('\n')
  const end = start + shown.length
  const notes: string[] = []
  if (body.length > MAX_OUTPUT_CHARS) {
    body = body.slice(0, MAX_OUTPUT_CHARS)
    notes.push(`Output cut at ${MAX_OUTPUT_CHARS} characters. Read the rest with a smaller limit or a later offset.`)
  } else if (start > 0 || end < lines.length) {
    notes.push(
      `Showing lines ${start + 1}-${end} of ${lines.length}.${end < lines.length ? ` Continue with offset ${end + 1}.` : ''}`,
    )
  }
  return notes.length ? `${body}\n\n[${notes.join(' ')}]` : body
}

export function createMcpServer({
  host,
  workspaces,
  delivery,
  agent,
  publicUrl,
  ssh,
  homeAssistant,
  runtime,
  data,
  secrets,
  storage,
  devices,
  appOrigin,
}: McpContext): McpServer {
  const server = new McpServer({ name: 'hobwork', version: '0.0.0' }, { instructions: INSTRUCTIONS })
  limitTools(server, agent.access)

  // main is never written through a workspace, so its checkout is refreshed to
  // the deployed commit on every read.
  function withAppUrls<T extends { name: string }>(projectName: string, branches: T[]) {
    return branches.map((b) => ({
      ...b,
      appUrl: appOrigin?.({ project: projectName, branch: b.name }) ?? null,
    }))
  }

  async function readableDir(projectName: string, branchName: string): Promise<string> {
    const workspace =
      branchName === DEFAULT_BRANCH
        ? await workspaces.sync(projectName, branchName)
        : await workspaces.open(projectName, branchName)
    return workspace.dir
  }

  async function writableDir(projectName: string, branchName: string): Promise<string> {
    if (branchName === DEFAULT_BRANCH) {
      throw new ProjectError(
        `${DEFAULT_BRANCH} is the deployed version and changes only by merging a branch. Create a branch with create_branch and make the change there`,
      )
    }
    return (await workspaces.open(projectName, branchName)).dir
  }

  server.registerTool(
    'list_projects',
    {
      description:
        'List the Hobwork projects you have access to, with the disk space each uses in bytes (storage), measured every few minutes. storage is null until the first measurement.',
      annotations: { readOnlyHint: true },
    },
    () =>
      json(
        listProjects(host)
          .filter(({ name }) => allowsProject(agent.access, name))
          .map((p) => ({
            name: p.name,
            defaultBranch: p.defaultBranch,
            createdAt: p.createdAt,
            ...(storage ? { storage: storage.get(p) } : {}),
          })),
      ),
  )

  server.registerTool(
    'create_project',
    {
      description:
        'Create a project from the Hobwork template (AGENTS.md, hobwork.json, an example route, cron and test). Then create a branch and read AGENTS.md before changing anything.',
      inputSchema: {
        name: z.string().describe('Project name in kebab-case, e.g. "sleep-alarms"'),
      },
    },
    async ({ name }) => {
      const created = await createProject(host, name)
      await runtime?.load(created.name)
      return json({ name: created.name, defaultBranch: created.defaultBranch })
    },
  )

  server.registerTool(
    'get_project',
    {
      description: `Show a project: its entry points and settings from hobwork.json on ${DEFAULT_BRANCH}, the URL of its dashboard, the hosts its handlers can reach, its secrets (names only), project DB size and slow query warnings, the disk space it uses in bytes (project DB, branch DB copies, workspace checkouts, repo, builds and log text; measured every few minutes), its branches with their preview URLs and the state of each branch workspace.`,
      inputSchema: { project },
      annotations: { readOnlyHint: true },
    },
    async ({ project: name }) => {
      const record = requireProject(host, name)
      const raw = await readFileAtRef(host, name, DEFAULT_BRANCH, 'hobwork.json')
      let config: Record<string, unknown> = {}
      let configError: string | undefined
      if (raw === undefined) configError = `hobwork.json is missing on ${DEFAULT_BRANCH}`
      else {
        try {
          config = parseHobworkJson(raw) as Record<string, unknown>
        } catch (err) {
          configError = `hobwork.json on ${DEFAULT_BRANCH} cannot be parsed: ${(err as Error).message}`
        }
      }
      const { crons = {}, webhooks = {}, routes = {}, triggers = {}, ...settings } = config
      const configEgress = Array.isArray(settings.egress) ? settings.egress.map(String) : []
      return json({
        name: record.name,
        defaultBranch: record.defaultBranch,
        createdAt: record.createdAt,
        appUrl: appOrigin?.({ project: name }) ?? null,
        entryPoints: { routes, crons, webhooks, triggers },
        settings,
        ...(configError ? { configError } : {}),
        egress: [...new Set([...configEgress, ...(secrets?.hosts(name) ?? [])])],
        secrets: secrets?.assigned(name).map((secret) => secret.envName) ?? [],
        ...(data ? { database: data.status(name) } : {}),
        ...(storage ? { storage: storage.get(record) } : {}),
        branches: withAppUrls(name, await listBranches(host, name)),
        workspaces: workspaces
          .list(name)
          .map(({ branch: b, status, lastUsedAt }) => ({ branch: b, status, lastUsedAt })),
      })
    },
  )

  server.registerTool(
    'create_branch',
    {
      description: `Create a branch to work on. Changes are always made on a branch, never on ${DEFAULT_BRANCH}.`,
      inputSchema: {
        project,
        branch: z.string().describe('New branch name, e.g. "add-spool-route". Letters, digits, ".", "_", "-" and "/"'),
        from: z.string().default(DEFAULT_BRANCH).describe('Branch or commit to start from'),
      },
    },
    async ({ project: p, branch: b, from }) => json(await createBranch(host, p, b, from)),
  )

  server.registerTool(
    'list_branches',
    {
      description: 'List the branches of a project with their latest commit, workspace state and app URL (the dashboard and routes of that branch).',
      inputSchema: { project },
      annotations: { readOnlyHint: true },
    },
    async ({ project: p }) => {
      const statuses = new Map(workspaces.list(p).map((w) => [w.branch, w.status]))
      return json(
        withAppUrls(p, await listBranches(host, p)).map((b) => ({ ...b, workspace: statuses.get(b.name) ?? 'none' })),
      )
    },
  )

  server.registerTool(
    'read_file',
    {
      description:
        'Read a text file on a branch, including uncommitted changes in its workspace. Returns the exact file content, suitable for edit_file.',
      inputSchema: {
        project,
        branch,
        path: filePath,
        offset: z.number().int().min(1).default(1).describe('First line to return, starting at 1'),
        limit: z.number().int().min(1).default(MAX_READ_LINES).describe('Number of lines to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project: p, branch: b, path, offset, limit }) => {
      const content = await readCheckoutFile(await readableDir(p, b), path)
      if (content.subarray(0, 8000).includes(0)) return text(`"${path}" is a binary file (${content.length} bytes)`)
      return text(formatReadResult(content.toString('utf8'), offset, limit))
    },
  )

  server.registerTool(
    'write_file',
    {
      description:
        'Create or overwrite a file on a branch with the given content. Parent directories are created as needed. Prefer edit_file for changes to existing files.',
      inputSchema: {
        project,
        branch: writableBranch,
        path: filePath,
        content: z.string().describe('The complete new file content'),
      },
    },
    async ({ project: p, branch: b, path, content }) => {
      const { created } = await writeCheckoutFile(await writableDir(p, b), path, content)
      return text(`${created ? 'Created' : 'Updated'} ${path}`)
    },
  )

  server.registerTool(
    'edit_file',
    {
      description:
        'Replace an exact string in a file on a branch. old_string must match the file exactly (whitespace and indentation included) and must occur once, unless replace_all is set.',
      inputSchema: {
        project,
        branch: writableBranch,
        path: filePath,
        old_string: z.string().describe('Exact text to replace'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z.boolean().default(false).describe('Replace every occurrence instead of exactly one'),
      },
    },
    async ({ project: p, branch: b, path, old_string, new_string, replace_all }) => {
      const { replacements } = await editCheckoutFile(
        await writableDir(p, b),
        path,
        old_string,
        new_string,
        replace_all,
      )
      return text(`Edited ${path} (${replacements} ${replacements === 1 ? 'replacement' : 'replacements'})`)
    },
  )

  server.registerTool(
    'delete_file',
    {
      description: 'Delete a file on a branch. Directories cannot be deleted directly; delete the files in them.',
      inputSchema: { project, branch: writableBranch, path: filePath },
      annotations: { destructiveHint: true },
    },
    async ({ project: p, branch: b, path }) => {
      await deleteCheckoutFile(await writableDir(p, b), path)
      return text(`Deleted ${path}`)
    },
  )

  server.registerTool(
    'list_files',
    {
      description:
        'List files on a branch. Recursive listings return files only and skip .git and node_modules; non-recursive listings also show directories with a trailing "/".',
      inputSchema: {
        project,
        branch,
        path: z.string().default('.').describe('Directory relative to the project root'),
        recursive: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project: p, branch: b, path, recursive }) => {
      const { entries, truncated } = await listCheckoutFiles(await readableDir(p, b), path, recursive)
      if (!entries.length) return text('(no files)')
      return text(entries.join('\n') + (truncated ? `\n[Listing cut at ${entries.length} entries. List a subdirectory.]` : ''))
    },
  )

  server.registerTool(
    'search',
    {
      description:
        'Search file contents on a branch with a regular expression (JavaScript syntax), line by line. Returns "path:line: text" for each matching line. Skips .git, node_modules, binary files and files over 1 MB.',
      inputSchema: {
        project,
        branch,
        pattern: z.string().describe('Regular expression, e.g. "export default" or "fetch\\\\("'),
        path: z.string().default('.').describe('Directory or file to search, relative to the project root'),
        glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts" or "src/**/*.tsx"'),
        ignore_case: z.boolean().default(false),
        max_results: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project: p, branch: b, pattern, path, glob, ignore_case, max_results }) => {
      const result = await searchCheckout(await readableDir(p, b), {
        path,
        pattern,
        glob,
        ignoreCase: ignore_case,
        maxMatches: max_results,
      })
      if (!result.matches.length) return text(`No matches in ${result.filesSearched} files`)
      return text(
        result.matches.join('\n') +
          (result.truncated ? `\n[Stopped at ${max_results} matches. Narrow the search or raise max_results.]` : ''),
      )
    },
  )

  server.registerTool(
    'bash',
    {
      description:
        'Run a shell command in the branch workspace VM, with the branch files as the working tree. Use it for pnpm install, pnpm typecheck, pnpm lint, pnpm test and similar. The VM starts on first use. Returns the exit code, stdout and stderr (long output is cut in the middle). The VM also has a hobwork command (hobwork status, commit, merge, logs), mainly for SSH sessions.',
      inputSchema: {
        project,
        branch: writableBranch,
        command: z.string().describe('Shell command line, e.g. "pnpm test"'),
        cwd: z.string().default('.').describe('Working directory relative to the project root'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_BASH_TIMEOUT_SECONDS)
          .default(DEFAULT_BASH_TIMEOUT_SECONDS),
      },
    },
    async ({ project: p, branch: b, command, cwd, timeout_seconds }, extra) => {
      if (!workspaces.canStartVms) {
        throw new ProjectError(
          'This Hobwork host cannot run commands: no workspace VM backend is configured. File tools, commit, diff and log still work',
        )
      }
      const dir = await checkoutDirectory(await writableDir(p, b), cwd)
      const vm = await workspaces.start(p, b)
      const session = workspaces.openSession(p, b, agent)
      const outcome = await runBash(vm, command, {
        cwd: dir,
        timeoutMs: timeout_seconds * 1000,
        signal: extra.signal,
        env: session.env,
      }).finally(() => session.close())
      workspaces.touch(p, b)
      return { ...text(outcome.text), isError: outcome.failed }
    },
  )

  server.registerTool(
    'commit',
    {
      description:
        'Commit all changes in the branch workspace (new, changed and deleted files) and push them to the branch. You are recorded as the author.',
      inputSchema: {
        project,
        branch: writableBranch,
        message: z.string().describe('Commit message: a short summary line, optionally followed by a blank line and details'),
      },
    },
    async ({ project: p, branch: b, message }) => {
      await writableDir(p, b)
      const sha = await workspaces.commit(p, b, message, {
        name: agent.name,
        email: `agent-${agent.id}@hobwork.local`,
      })
      return text(sha ? `Committed ${sha}` : 'Nothing to commit')
    },
  )

  server.registerTool(
    'diff',
    {
      description: `Show a unified diff for a branch. scope "uncommitted" shows workspace changes not yet committed; scope "branch" shows everything committed on the branch since it diverged from ${DEFAULT_BRANCH}, which is what a merge would apply.`,
      inputSchema: {
        project,
        branch: writableBranch,
        scope: z.enum(['uncommitted', 'branch']).default('uncommitted'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project: p, branch: b, scope }) => {
      let diff: string
      if (scope === 'branch') diff = await diffBranch(host, p, b)
      else {
        await writableDir(p, b)
        diff = await workspaces.diff(p, b)
      }
      return text(diff ? truncateMiddle(diff) : 'No changes')
    },
  )

  server.registerTool(
    'log',
    {
      description: 'Show recent commits on a branch, newest first.',
      inputSchema: {
        project,
        ref: z.string().default(DEFAULT_BRANCH).describe('Branch or commit'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project: p, ref, limit }) => json(await log(host, p, ref, limit)),
  )

  registerDeliveryTools(server, { host, delivery, agent })
  if (homeAssistant) {
    registerHomeAssistantTools(server, homeAssistant)
    registerBranchHaTools(server, { host, agent })
  }
  registerRuntimeTools(server, { host, runtime })
  registerSecretTools(server, { host, secrets, agent, publicUrl })
  registerSshKeyTools(server, { host, agent, ssh })
  if (devices) registerDeviceTools(server, devices)

  return server
}
