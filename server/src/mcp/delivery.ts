import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import type { Agent } from '../agents.ts'
import type { Delivery, MergeResult } from '../delivery.ts'
import type { Host } from '../host.ts'
import { getRun, latestRun, type PipelineRun } from '../pipeline/runner.ts'
import { DEFAULT_BRANCH, ProjectError, requireProject } from '../projects.ts'
import { listVersions } from '../versions.ts'
import { truncateMiddle } from './output.ts'

const PASSED_STEP_OUTPUT_CHARS = 2_000

const project = z.string().describe('Project name, e.g. "filament-tracker"')

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) }
}

// Failed step output is shown in full (up to the stored limit); the rest is cut
// short so a status stays readable.
function formatRun(run: PipelineRun): string {
  const lines = [
    `Pipeline run ${run.id} for ${run.project}${run.branch ? ` (${run.branch})` : ''}: ${run.status}`,
    `commit ${run.commit}, started ${run.startedAt}${run.finishedAt ? `, finished ${run.finishedAt}` : ''}`,
  ]
  for (const step of run.steps) {
    const duration = step.durationMs === null ? '' : ` (${(step.durationMs / 1000).toFixed(1)}s)`
    lines.push('', `## ${step.name}: ${step.status}${duration}`)
    if (step.output) {
      lines.push(step.status === 'failed' ? step.output : truncateMiddle(step.output, PASSED_STEP_OUTPUT_CHARS))
    }
  }
  return lines.join('\n')
}

function formatMerge(branch: string, result: MergeResult): CallToolResult {
  if (result.status === 'conflict') {
    return text(
      [
        `${branch} does not apply on top of the current ${DEFAULT_BRANCH}. Conflicting files:`,
        ...result.files.map((file) => `- ${file}`),
        '',
        `${DEFAULT_BRANCH} changed these files since the branch started. Create a new branch from ${DEFAULT_BRANCH}, redo the change there on top of the current code, and merge that branch.`,
        '',
        truncateMiddle(result.output),
      ].join('\n'),
      true,
    )
  }
  if (result.status === 'failed') {
    const step = result.run.steps.find((s) => s.name === result.run.failedStep)
    return text(
      [
        `Merge refused: the ${result.run.failedStep} step failed in pipeline run ${result.run.id}. ${DEFAULT_BRANCH} is unchanged. Fix the problem on ${branch}, commit and merge again.`,
        '',
        step?.output ?? '',
      ].join('\n'),
      true,
    )
  }
  const lines = [
    `Merged ${branch} into ${DEFAULT_BRANCH} as version ${result.version.number} (commit ${result.version.commit}). Pipeline run ${result.run.id} passed.`,
    result.branchReset
      ? `${branch} now points at the new ${DEFAULT_BRANCH}. Keep working on it for further changes.`
      : `${branch} changed while the merge ran and was left as it was. Create a new branch from ${DEFAULT_BRANCH} for further changes.`,
  ]
  if (result.deployError) lines.push(`Deploying version ${result.version.number} failed: ${result.deployError}`)
  return text(lines.join('\n'), result.deployError !== undefined)
}

export function registerDeliveryTools(server: McpServer, { host, delivery, agent }: { host: Host; delivery: Delivery; agent: Agent }) {
  server.registerTool(
    'merge',
    {
      description: `Merge a branch into ${DEFAULT_BRANCH} and deploy it. Only committed changes are merged, so commit first. The branch's changes are squashed and rebased onto the current ${DEFAULT_BRANCH}, then the pipeline runs in a fresh VM: validate hobwork.json, install extra dependencies, typecheck, lint, test, build. If every step passes, the change lands on ${DEFAULT_BRANCH} as one commit with the summary as its message, becomes a new version and is deployed. Otherwise ${DEFAULT_BRANCH} is unchanged and the failing step's output is returned. After a successful merge the branch and its workspace are reset to the new ${DEFAULT_BRANCH}, so you can keep working on the same branch. Can take several minutes.`,
      inputSchema: {
        project,
        branch: z.string().describe(`Branch to merge. Must not be ${DEFAULT_BRANCH}`),
        summary: z
          .string()
          .describe('What the change does and why, for the version list: a short summary line, optionally followed by a blank line and details'),
      },
    },
    async ({ project: p, branch, summary }) =>
      formatMerge(branch, await delivery.merge({ project: p, branch, summary, agent })),
  )

  server.registerTool(
    'pipeline_status',
    {
      description:
        'Show a pipeline run with the status, duration and output of each step. Without run_id, shows the latest run of the project, or of a branch if given.',
      inputSchema: {
        project,
        run_id: z.number().int().optional().describe('Pipeline run ID, as returned by merge'),
        branch: z.string().optional().describe('Show the latest run for this branch'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project: p, run_id, branch }) => {
      requireProject(host, p)
      const run = run_id === undefined ? latestRun(host, p, branch) : getRun(host, run_id)
      if (!run || run.project !== p) {
        throw new ProjectError(run_id === undefined ? `No pipeline runs in ${p}${branch ? ` for ${branch}` : ''}` : `Pipeline run ${run_id} does not exist in ${p}`)
      }
      return text(formatRun(run))
    },
  )

  server.registerTool(
    'list_versions',
    {
      description: `List the versions of a project, newest first. Every merge and every restore creates a version; the newest is what runs on ${DEFAULT_BRANCH}.`,
      inputSchema: { project, limit: z.number().int().min(1).max(200).default(20) },
      annotations: { readOnlyHint: true },
    },
    async ({ project: p, limit }) => {
      requireProject(host, p)
      return text(JSON.stringify(listVersions(host, p, limit), null, 2))
    },
  )

  server.registerTool(
    'restore_version',
    {
      description: `Restore the code of an earlier version: commits that version's files as a new commit on ${DEFAULT_BRANCH}, records it as a new version and deploys it. History is kept, so a restore can itself be undone by restoring again. Data is not rolled back. The pipeline does not run.`,
      inputSchema: { project, version: z.number().int().min(1).describe('Version number from list_versions') },
      annotations: { destructiveHint: true },
    },
    async ({ project: p, version }) => {
      const result = await delivery.restore({ project: p, version, agent })
      const lines = [
        `Restored version ${version} as version ${result.version.number} (commit ${result.version.commit}).`,
      ]
      if (result.deployError) lines.push(`Deploying version ${result.version.number} failed: ${result.deployError}`)
      return text(lines.join('\n'), result.deployError !== undefined)
    },
  )
}
