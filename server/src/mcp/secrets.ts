import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import { allowsProject } from '../access.ts'
import type { AuthenticatedAgent } from '../agents.ts'
import type { Host } from '../host.ts'
import { ProjectError, requireProject } from '../projects.ts'
import { MAX_ENV_NAME_LENGTH, MAX_HOST_REQUEST_REASON, type SecretStore } from '../secrets.ts'

const project = z.string().describe('Project name, e.g. "filament-tracker"')
const envName = z
  .string()
  .max(MAX_ENV_NAME_LENGTH)
  .describe('Env var name the project sees, e.g. "SPOOLMAN_TOKEN". Handlers read it as ctx.secrets.SPOOLMAN_TOKEN')

// Agents can see the library and assign secrets to projects. They never see
// values and cannot create secrets or change their values. They can only ask
// for hosts, which a person approves: with hosts under an agent's control,
// assigning a secret would be enough to send its value anywhere.
export function registerSecretTools(
  server: McpServer,
  { host, secrets, agent, publicUrl }: { host: Host; secrets?: SecretStore; agent: AuthenticatedAgent; publicUrl: string },
) {
  function store(): SecretStore {
    if (!secrets) throw new ProjectError('This Hobwork host has no secret store')
    return secrets
  }

  server.registerTool(
    'list_secrets',
    {
      description:
        "List the secrets in Hobwork: each secret's name, the hosts its value may be sent to, and the projects it is assigned to with the env name each project uses. With a project, only the secrets assigned to it, by env name. Values are never shown. pendingHosts are hosts asked for with request_secret_hosts that wait for the user's approval. Only the user creates secrets and sets their values, in the Hobwork UI.",
      inputSchema: { project: project.optional().describe('Only the secrets assigned to this project') },
      annotations: { readOnlyHint: true },
    },
    ({ project: name }) => {
      if (name !== undefined) {
        requireProject(host, name)
        const assigned = store()
          .assigned(name)
          .map(({ envName: env, secret, hosts }) => ({ envName: env, secret, hosts }))
        const text = assigned.length
          ? JSON.stringify(assigned, null, 2)
          : `${name} has no secrets assigned. Call list_secrets without a project to see every secret, and assign one with assign_secret.`
        return { content: [{ type: 'text', text }] }
      }
      const library = store()
        .list()
        .map(({ name: secret, hosts, pendingHostRequest, assignments }) => ({
          name: secret,
          hosts,
          ...(pendingHostRequest ? { pendingHosts: pendingHostRequest.hosts } : {}),
          projects: assignments
            .filter(({ project: p }) => allowsProject(agent.access, p))
            .map(({ project: p, envName: env }) => ({ project: p, envName: env })),
        }))
      const text = library.length
        ? JSON.stringify(library, null, 2)
        : 'There are no secrets yet. Ask the user to create the one you need in Hobwork.'
      return { content: [{ type: 'text', text }] }
    },
  )

  server.registerTool(
    'assign_secret',
    {
      description:
        "Give a project an existing secret under an env var name. Its handlers and branch workspaces get ctx.secrets.<env name> (a placeholder that Hobwork replaces with the value in request headers to the secret's hosts), and those hosts become reachable. Running VMs pick it up on their next invocation or bash command. The user sees the change in the project log. If the secret does not exist, ask the user to create it in Hobwork. If it has no hosts or lacks one, ask for them with request_secret_hosts.",
      inputSchema: {
        project,
        secret: z.string().describe('Secret name as list_secrets shows it, e.g. "Spoolman API key"'),
        env_name: envName,
      },
    },
    ({ project: name, secret, env_name }) => {
      const assigned = store().assign(name, secret, env_name, { kind: 'agent', id: agent.id, name: agent.name })
      return {
        content: [
          {
            type: 'text',
            text: assigned.hosts.length
              ? `Assigned "${assigned.secret}" to ${name} as ${assigned.envName}. Handlers can send ctx.secrets.${assigned.envName} to ${assigned.hosts.join(', ')}.`
              : `Assigned "${assigned.secret}" to ${name} as ${assigned.envName}. It has no hosts yet, so it is not sent anywhere. Ask for them with request_secret_hosts.`,
          },
        ],
      }
    },
  )

  server.registerTool(
    'unassign_secret',
    {
      description:
        "Take a secret away from a project. Its handlers and workspaces lose the env var and the secret's hosts from their next invocation or bash command. The secret stays in Hobwork.",
      inputSchema: { project, env_name: envName.describe('Env var name the project uses for the secret') },
      annotations: { destructiveHint: true },
    },
    ({ project: name, env_name }) => {
      if (!store().unassign(name, env_name, { kind: 'agent', id: agent.id, name: agent.name })) {
        throw new ProjectError(`${name} has no secret as ${env_name}. list_secrets with the project shows its secrets`)
      }
      return { content: [{ type: 'text', text: `Unassigned ${env_name} from ${name}.` }] }
    },
  )

  server.registerTool(
    'request_secret_hosts',
    {
      description:
        "Ask the user to approve the hosts a secret may be sent to, e.g. when they created a secret without hosts. The hosts replace the secret's current hosts once the user approves, so list every host it needs. Returns a link: show it to the user and ask them to open it and approve. A newer request for the same secret replaces an unanswered one. list_secrets shows the hosts once approved.",
      inputSchema: {
        secret: z.string().describe('Secret name as list_secrets shows it, e.g. "Spoolman API key"'),
        hosts: z
          .array(z.string())
          .min(1)
          .describe('Every host the value may be sent to, e.g. ["api.spools.example"]. *.example.com covers its subdomains'),
        reason: z
          .string()
          .max(MAX_HOST_REQUEST_REASON)
          .describe('One sentence for the user on why the secret goes to these hosts, e.g. "The Spoolman API lives at api.spools.example"'),
      },
    },
    ({ secret, hosts, reason }) => {
      const request = store().requestHosts(secret, hosts, reason, { kind: 'agent', id: agent.id, name: agent.name })
      const url = new URL(`/secrets/requests/${request.id}`, publicUrl).href
      return {
        content: [
          {
            type: 'text',
            text: `Asked to send "${request.secret.name}" to ${request.hosts.join(', ')}. Show the user this link and ask them to approve: ${url}`,
          },
        ],
      }
    },
  )
}
