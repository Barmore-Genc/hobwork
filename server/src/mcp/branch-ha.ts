import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import type { Agent } from '../agents.ts'
import { grantBranchHa, revokeBranchHa } from '../homeassistant/approvals.ts'
import { getHaServices, haServicesNote, HaServicesError, setHaServices } from '../homeassistant/services.ts'
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

  server.registerTool(
    'update_ha_services',
    {
      description:
        'Change which Home Assistant services a hob\'s deployed handlers may call and which events they may fire. A hob calls and fires none until its list names them. An entry is a domain ("light", all its services), one service ("light.turn_on") or an event type ("event:my_hob_changed", for ctx.ha.fireEvent; events can trigger the user\'s automations, so add only the ones the hob needs). Other calls fail with code not_allowed and show up in the hob log. hassio.*, homeassistant.*, shell_command.* and recorder.purge* services and Home Assistant\'s own events (state_changed, call_service, homeassistant_* and similar) are never allowed. Use ha_list_services to find names, add only what the hob needs, and tell the user what you added. Applies to the next call. get_hob shows the current list.',
      inputSchema: {
        hob: z.string().describe('Hob name, e.g. "filament-tracker"'),
        add: z.array(z.string()).default([]).describe('Entries to allow, e.g. ["light", "tts.speak", "event:spool_empty"]'),
        remove: z.array(z.string()).default([]).describe('Entries to stop allowing'),
      },
    },
    ({ hob: project, add, remove }) => {
      const { id } = requireProject(host, project)
      try {
        const removed = new Set(remove.map((entry) => entry.trim()))
        const next = [...getHaServices(host.db, id).filter((entry) => !removed.has(entry) && !removed.has(entry.toLowerCase())), ...add]
        const services = setHaServices(host, project, next, { kind: 'agent', name: agent.name })
        return { content: [{ type: 'text', text: `${project}: ${haServicesNote(services)}` }] }
      } catch (err) {
        if (err instanceof HaServicesError) throw new ProjectError(err.message)
        throw err
      }
    },
  )
}
