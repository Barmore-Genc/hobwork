import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAgentToken, revokeAgentToken } from './agents.ts'
import { onChange, publishChange, type Change } from './changes.ts'
import { createPairingCode, exchangePairingCode, renameDevice, revokeDevice } from './devices/store.ts'
import { pkce } from './devices/test-devices.ts'
import { grantBranchHa, revokeBranchHa } from './homeassistant/approvals.ts'
import { deleteProject, restoreProject, listTrash } from './project-deletion.ts'
import { renameProject } from './project-rename.ts'
import { createProject, getProject } from './projects.ts'
import { createBranch, deleteBranchRef } from './repo.ts'
import { appendLog, finishInvocation, startInvocation } from './runtime/logs.ts'
import { rotateWebhookToken } from './runtime/webhooks.ts'
import { createSecretStore, type Actor } from './secrets.ts'
import { addSshKey, generateEd25519KeyPair, revokeSshKey } from './ssh/keys.ts'
import { createTestHost } from './test-host.ts'
import { signedIn } from './test-web.ts'
import { recordVersion } from './versions.ts'
import { createWorkspaceManager } from './workspaces.ts'

let host: ReturnType<typeof createTestHost>
let changes: Change[]

beforeEach(async () => {
  host = createTestHost()
  await createProject(host, 'filament')
  changes = []
  onChange(host.db, (change) => changes.push(change))
})

afterEach(() => host.dispose())

// What was published since the last call.
function published(): Change[] {
  return changes.splice(0)
}

test('listeners only hear changes of their own host, and a failing one does not stop the rest', () => {
  const other = createTestHost()
  const heard: Change[] = []
  onChange(other.db, () => {
    throw new Error('broken listener')
  })
  const stop = onChange(other.db, (change) => heard.push(change))
  publishChange(other.db, { kind: 'agents' })
  stop()
  publishChange(other.db, { kind: 'devices' })
  expect(heard).toEqual([{ kind: 'agents' }])
  expect(published()).toEqual([])
  other.dispose()
})

test('creating a project and recording versions change the project list and the project', async () => {
  await createProject(host, 'alarms')
  expect(published()).toEqual([{ kind: 'project', project: 'alarms' }, { kind: 'projects' }])
  const { id } = getProject(host, 'filament')!
  recordVersion(host, { projectId: id, commit: 'a'.repeat(40), summary: 'Add spools' })
  rotateWebhookToken(host, 'filament', 'scanned')
  expect(published()).toEqual([
    { kind: 'project', project: 'filament' },
    { kind: 'project', project: 'filament' },
  ])
})

test('invocations and log lines name their project', () => {
  const id = startInvocation(host, { project: 'filament', version: 1, kind: 'cron', name: 'tick', manual: false })
  appendLog(host, { project: 'filament', invocationId: id, source: 'handler', level: 'info', message: 'ticked' })
  finishInvocation(host, id, { status: 'ok', durationMs: 5 })
  expect(published()).toEqual([
    { kind: 'invocations', project: 'filament', id },
    { kind: 'logs', project: 'filament' },
    { kind: 'invocations', project: 'filament', id },
  ])
})

test('branches change when they are created, deleted or allowed to use Home Assistant', async () => {
  const { user } = signedIn(host)
  published()
  await createBranch(host, 'filament', 'add-spools')
  grantBranchHa(host, 'filament', 'add-spools', { userId: user.id })
  revokeBranchHa(host, 'filament', 'add-spools')
  revokeBranchHa(host, 'filament', 'add-spools')
  await deleteBranchRef(host, 'filament', 'add-spools')
  expect(published()).toEqual(Array(4).fill({ kind: 'branches', project: 'filament' }))
})

test('secret changes by people and agents change the secrets', () => {
  const store = createSecretStore(host, randomBytes(32))
  const person: Actor = { kind: 'host' }
  const { agent } = createAgentToken(host.db, 'claude')
  published()
  const secret = store.create({ name: 'Spoolman', value: 'token', hosts: [] }, person)
  store.assign('filament', secret.id, 'SPOOLMAN_TOKEN', { kind: 'agent', id: agent.id, name: agent.name })
  const request = store.requestHosts(secret.id, ['spoolman.example.com'], 'Reads spools', { kind: 'agent', id: agent.id, name: agent.name })
  store.decideHostRequest(request.id, true, person)
  store.unassign('filament', 'SPOOLMAN_TOKEN', person)
  store.remove(secret.id, person)
  // Approving changes the secret's hosts and the request.
  expect(published().filter((c) => c.kind !== 'logs')).toEqual(Array(7).fill({ kind: 'secrets' }))
})

test('agent keys, SSH keys and devices change their lists', () => {
  const { agent } = createAgentToken(host.db, 'claude')
  const tokenId = Number(host.db.prepare('SELECT id FROM agent_tokens WHERE agent_id = ?').get(agent.id)!.id)
  revokeAgentToken(host.db, tokenId)
  const key = addSshKey(host.db, agent.id, 'laptop', generateEd25519KeyPair().public, { via: 'host' })
  revokeSshKey(host.db, key.id)
  expect(published()).toEqual(Array(4).fill({ kind: 'agents' }))

  const { user } = signedIn(host)
  expect(published()).toEqual([{ kind: 'people' }])
  const { verifier, challenge } = pkce()
  const code = createPairingCode(host.db, { userId: user.id, name: 'kaans-iphone', platform: 'ios', codeChallenge: challenge })
  const { device } = exchangePairingCode(host.db, code, verifier)
  renameDevice(host.db, device.id, 'phone')
  revokeDevice(host.db, device.id)
  expect(published()).toEqual(Array(3).fill({ kind: 'devices' }))
})

test('deleting, restoring and renaming a project change every list that names it', async () => {
  const workspaces = createWorkspaceManager(host)
  await deleteProject({ host, workspaces }, 'filament')
  const everywhere = (...projects: string[]) => [
    { kind: 'projects' },
    ...projects.map((project) => ({ kind: 'project', project })),
    { kind: 'agents' },
    { kind: 'secrets' },
  ]
  expect(published().filter((c) => c.kind !== 'logs')).toEqual([...everywhere('filament'), { kind: 'trash' }])

  await restoreProject({ host }, listTrash(host)[0]!.id)
  expect(published().filter((c) => c.kind !== 'logs')).toEqual([...everywhere('filament'), { kind: 'trash' }])

  await renameProject({ host, workspaces }, 'filament', 'spools')
  expect(published().filter((c) => c.kind !== 'logs')).toEqual(everywhere('filament', 'spools'))
})
