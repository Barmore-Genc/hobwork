import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import type { AuthenticatedAgent } from '../agents.ts'
import type { Host } from '../host.ts'
import { addSshKey, listSshKeys, MAX_SSH_KEY_NAME, revokeSshKey, SshKeyError, type SshKey } from '../ssh/keys.ts'

export type SshAddress = { host: string; port: number }

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function describe(key: SshKey) {
  return {
    id: key.id,
    name: key.name,
    fingerprint: key.fingerprint,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  }
}

// Keys an agent adds are tied to the agent key or sign-in it used, so revoking
// that access also revokes them.
export function registerSshKeyTools(
  server: McpServer,
  { host, agent, ssh }: { host: Host; agent: AuthenticatedAgent; ssh?: SshAddress },
) {
  const connect = ssh
    ? `ssh -p ${ssh.port} <project>/<branch>@${ssh.host}`
    : 'the SSH gateway, which is turned off on this Hobwork host'

  server.registerTool(
    'add_ssh_key',
    {
      description: `Register an SSH public key for yourself, so you can open a shell in a branch workspace with ${connect}. The user sees the key and its name on the Agent access page. Revoking the access you use now also revokes this key.`,
      inputSchema: {
        name: z
          .string()
          .max(MAX_SSH_KEY_NAME)
          .describe('Name that tells the user where the key lives, e.g. "Claude Code on the laptop"'),
        public_key: z.string().describe('One public key line, e.g. the contents of ~/.ssh/id_ed25519.pub'),
      },
    },
    ({ name, public_key }) => {
      try {
        const key = addSshKey(host.db, agent.id, name, public_key, { via: 'agent', credential: agent.credential })
        return text(`Added SSH key "${key.name}" (${key.fingerprint}). Connect with ${connect}.`)
      } catch (err) {
        if (err instanceof SshKeyError) return { ...text(err.message), isError: true }
        throw err
      }
    },
  )

  server.registerTool(
    'list_ssh_keys',
    {
      description: 'List your SSH keys, including revoked ones.',
      annotations: { readOnlyHint: true },
    },
    () => {
      const keys = listSshKeys(host.db, agent.id).map(describe)
      return text(keys.length ? JSON.stringify(keys, null, 2) : 'You have no SSH keys. Add one with add_ssh_key.')
    },
  )

  server.registerTool(
    'revoke_ssh_key',
    {
      description: 'Revoke one of your SSH keys. It stops working right away, and this cannot be undone.',
      inputSchema: { id: z.number().int().positive().describe('Key id from list_ssh_keys') },
      annotations: { destructiveHint: true },
    },
    ({ id }) => {
      if (!revokeSshKey(host.db, id, agent.id)) {
        return { ...text(`You have no working SSH key with id ${id}.`), isError: true }
      }
      return text(`Revoked SSH key ${id}.`)
    },
  )
}
