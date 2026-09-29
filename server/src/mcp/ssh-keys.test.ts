import { afterEach, beforeEach, expect, test } from 'vitest'
import { ensureAgent, listAgents, revokeAgentToken } from '../agents.ts'
import { addSshKey, findSshKey, generateEd25519KeyPair, listSshKeys } from '../ssh/keys.ts'
import { startTestMcp, textOf, type TestMcp } from './test-mcp.ts'

let mcp: TestMcp

beforeEach(async () => {
  mcp = await startTestMcp({ sshPort: 2222 })
})

afterEach(() => mcp.close())

function keyData(publicKey: string): Buffer {
  return Buffer.from(publicKey.split(' ')[1]!, 'base64')
}

test('agents add named SSH keys, list them and revoke them', async () => {
  const { public: publicKey } = generateEd25519KeyPair()
  const unnamed = await mcp.call('add_ssh_key', { name: '  ', public_key: publicKey })
  expect(unnamed.isError).toBe(true)
  expect(textOf(unnamed)).toBe('Give the SSH key a name')

  const added = await mcp.call('add_ssh_key', { name: 'Claude Code on the laptop', public_key: publicKey })
  expect(textOf(added)).toMatch(
    /^Added SSH key "Claude Code on the laptop" \(SHA256:\S+\)\. Connect with ssh -p 2222 <project>\/<branch>@localhost\.$/,
  )
  expect(findSshKey(mcp.host.db, keyData(publicKey))?.agent.name).toBe('claude')

  const [key] = JSON.parse(textOf(await mcp.call('list_ssh_keys')))
  expect(key).toMatchObject({ name: 'Claude Code on the laptop', lastUsedAt: null, revokedAt: null })
  const [token] = listAgents(mcp.host.db)[0]!.tokens
  expect(listSshKeys(mcp.host.db)[0]?.addedFrom).toEqual({
    via: 'agent',
    token: { id: token!.id, createdAt: token!.createdAt },
    signIn: null,
  })

  expect(textOf(await mcp.call('revoke_ssh_key', { id: key.id }))).toBe(`Revoked SSH key ${key.id}.`)
  expect(findSshKey(mcp.host.db, keyData(publicKey))).toBeUndefined()
  expect((await mcp.call('revoke_ssh_key', { id: key.id })).isError).toBe(true)

  const again = await mcp.call('add_ssh_key', { name: 'Laptop again', public_key: publicKey })
  expect(again.isError).toBeFalsy()
  expect(JSON.parse(textOf(await mcp.call('list_ssh_keys'))).map((k: { name: string }) => k.name)).toEqual([
    'Laptop again',
    'Claude Code on the laptop',
  ])
})

test("agents cannot see or revoke another agent's keys", async () => {
  const other = ensureAgent(mcp.host.db, 'other')
  const { public: publicKey } = generateEd25519KeyPair()
  const key = addSshKey(mcp.host.db, other.id, 'Other', publicKey, { via: 'host' })
  expect(textOf(await mcp.call('list_ssh_keys'))).toBe('You have no SSH keys. Add one with add_ssh_key.')
  expect((await mcp.call('revoke_ssh_key', { id: key.id })).isError).toBe(true)
  expect(findSshKey(mcp.host.db, keyData(publicKey))).toBeDefined()

  const taken = await mcp.call('add_ssh_key', { name: 'Mine', public_key: publicKey })
  expect(textOf(taken)).toBe('This key is already registered to other')
})

test('revoking the agent key an agent used revokes the SSH keys it added', async () => {
  const added = generateEd25519KeyPair().public
  await mcp.call('add_ssh_key', { name: 'Laptop', public_key: added })
  const byUser = generateEd25519KeyPair().public
  const [agent] = listAgents(mcp.host.db)
  addSshKey(mcp.host.db, agent!.id, 'Desktop', byUser, { via: 'host' })

  expect(revokeAgentToken(mcp.host.db, agent!.tokens[0]!.id)).toBe(true)
  expect(findSshKey(mcp.host.db, keyData(added))).toBeUndefined()
  expect(findSshKey(mcp.host.db, keyData(byUser))).toBeDefined()
})
