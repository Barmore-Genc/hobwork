import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import type { Host } from '../host.ts'
import { ProjectError, requireProject } from '../projects.ts'
import type { SecretStore } from '../secrets.ts'

// Agents can see which secrets exist, never their values, and cannot create,
// change or delete them. There is deliberately no tool for that.
export function registerSecretTools(server: McpServer, { host, secrets }: { host: Host; secrets?: SecretStore }) {
  server.registerTool(
    'list_secrets',
    {
      description:
        "List the secrets a project's handlers can use: names, the hosts each is bound to, and whether it belongs to the project or is global. Values are never shown. In a handler, send ctx.secrets.NAME in a request header (e.g. Authorization) to a bound host; Hobwork replaces it with the real value on the way out. Bound hosts are reachable without listing them in egress. Only users can add or change secrets, in Hobwork; ask the user when one is missing.",
      inputSchema: { project: z.string().describe('Project name, e.g. "filament-tracker"') },
      annotations: { readOnlyHint: true },
    },
    ({ project }) => {
      requireProject(host, project)
      if (!secrets) throw new ProjectError('This Hobwork host has no secret store')
      const list = secrets.effective(project).map(({ name, scope, hosts, updatedAt }) => ({ name, scope, hosts, updatedAt }))
      const text = list.length
        ? JSON.stringify(list, null, 2)
        : `${project} has no secrets. Ask the user to add one in Hobwork, with the hosts it may be sent to.`
      return { content: [{ type: 'text', text }] }
    },
  )
}
