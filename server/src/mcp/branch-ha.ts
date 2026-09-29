import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import type { Agent } from '../agents.ts'
import { grantBranchHa, revokeBranchHa } from '../homeassistant/approvals.ts'
import type { Host } from '../host.ts'
import { DEFAULT_BRANCH, ProjectError, requireProject } from '../projects.ts'
import { branchExists } from '../repo.ts'

export function registerBranchHaTools(server: McpServer, { host, agent }: { host: Host; agent: Agent }) {
  server.registerTool(
    'set_branch_home_assistant',
    {
      description: `Let a branch preview call Home Assistant services and fire events, or stop it. Previews always read states; without this, service calls fail with code not_approved. It applies to the next call. The deployed version (${DEFAULT_BRANCH}) always may. The user sees on the hob page that you turned it on.`,
      inputSchema: {
        hob: z.string().describe('Hob name, e.g. "filament-tracker"'),
        branch: z.string().describe(`Branch name, not ${DEFAULT_BRANCH}`),
        allowed: z.boolean().describe('true to let the branch control Home Assistant, false to stop it'),
      },
    },
    async ({ hob: project, branch, allowed }) => {
      requireProject(host, project)
      if (branch === DEFAULT_BRANCH) throw new ProjectError(`${DEFAULT_BRANCH} always controls Home Assistant`)
      if (!(await branchExists(host, project, branch))) throw new ProjectError(`Branch "${branch}" does not exist in ${project}`)
      if (!allowed) {
        revokeBranchHa(host, project, branch)
        return { content: [{ type: 'text', text: `Branch "${branch}" of ${project} can no longer control Home Assistant.` }] }
      }
      grantBranchHa(host, project, branch, { agentId: agent.id })
      return { content: [{ type: 'text', text: `Branch "${branch}" of ${project} can now control Home Assistant.` }] }
    },
  )
}
