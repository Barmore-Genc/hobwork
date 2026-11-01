import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import type { Agent } from '../agents.ts'
import { grantBranchBrowser, revokeBranchBrowser } from '../browser/approvals.ts'
import type { Host } from '../host.ts'
import { DEFAULT_BRANCH, ProjectError, requireProject } from '../projects.ts'
import { branchExists } from '../repo.ts'

export function registerBranchBrowserTools(server: McpServer, { host, agent }: { host: Host; agent: Agent }) {
  server.registerTool(
    'set_branch_browser',
    {
      description: `Let a branch preview use the browser (ctx.browser), or stop it. Previews open nothing without this and answer code not_approved, so work in progress cannot log into a real account by accident. The deployed version (${DEFAULT_BRANCH}) always may, for the sites its committed hobwork.json declares in "browser.sites". It applies to the next call. The user sees on the hob page that you turned it on.`,
      inputSchema: {
        hob: z.string().describe('Hob name, e.g. "filament-tracker"'),
        branch: z.string().describe(`Branch name, not ${DEFAULT_BRANCH}`),
        allowed: z.boolean().describe('true to let the branch use the browser, false to stop it'),
      },
    },
    async ({ hob: project, branch, allowed }) => {
      requireProject(host, project)
      if (branch === DEFAULT_BRANCH) throw new ProjectError(`${DEFAULT_BRANCH} always may use the browser`)
      if (!(await branchExists(host, project, branch).catch(() => false))) throw new ProjectError(`Branch "${branch}" does not exist in ${project}`)
      if (!allowed) {
        revokeBranchBrowser(host, project, branch)
        return { content: [{ type: 'text', text: `Branch "${branch}" of ${project} can no longer use the browser.` }] }
      }
      grantBranchBrowser(host, project, branch, { agentId: agent.id })
      return { content: [{ type: 'text', text: `Branch "${branch}" of ${project} can now use the browser.` }] }
    },
  )
}
