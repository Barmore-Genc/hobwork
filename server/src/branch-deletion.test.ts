import { existsSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ensureAgent } from './agents.ts'
import { deleteBranch, removeMergedBranches, unmergedCommits } from './branch-deletion.ts'
import { branchMerges, recordBranchMerge } from './branch-merges.ts'
import { getBranchHaApproval, grantBranchHa } from './homeassistant/approvals.ts'
import { workspaceDir } from './host.ts'
import { createProject, requireProject } from './projects.ts'
import { branchExists, createBranch } from './repo.ts'
import { createTestHost } from './test-host.ts'
import { seedBranch, seedMain } from './test-project.ts'
import { createWorkspaceManager } from './workspaces.ts'

const DAY_MS = 24 * 60 * 60 * 1000

let host: ReturnType<typeof createTestHost>
let projectId: number

beforeEach(async () => {
  host = createTestHost()
  await createProject(host, 'filament')
  await seedMain(host, 'filament')
  projectId = requireProject(host, 'filament').id
})

afterEach(() => {
  host.dispose()
})

function deps() {
  const removedPreviews: string[] = []
  return {
    host,
    workspaces: createWorkspaceManager(host),
    runtime: { removePreview: async (project: string, branch: string) => void removedPreviews.push(`${project}/${branch}`) },
    removedPreviews,
  }
}

test('deletes a branch with its workspace, preview and access', async () => {
  const d = deps()
  await createBranch(host, 'filament', 'spools')
  await d.workspaces.open('filament', 'spools')
  grantBranchHa(host, 'filament', 'spools', { agentId: ensureAgent(host.db, 'claude').id })

  await deleteBranch(d, 'filament', 'spools')

  expect(await branchExists(host, 'filament', 'spools')).toBe(false)
  expect(existsSync(workspaceDir(host, 'filament', 'spools'))).toBe(false)
  expect(getBranchHaApproval(host, 'filament', 'spools')).toBeUndefined()
  expect(d.removedPreviews).toEqual(['filament/spools'])
})

test('refuses to delete unmerged work unless told to discard it', async () => {
  const d = deps()
  await seedBranch(host, 'filament', 'spools', { 'src/a.ts': 'export const a = 2\n' })
  expect(await unmergedCommits(host, 'filament', 'spools')).toBe(1)

  await expect(deleteBranch(d, 'filament', 'spools')).rejects.toThrow('1 commit that main does not have')
  expect(await branchExists(host, 'filament', 'spools')).toBe(true)

  await deleteBranch(d, 'filament', 'spools', { discard: true })
  expect(await branchExists(host, 'filament', 'spools')).toBe(false)
})

test('main cannot be deleted', async () => {
  await expect(deleteBranch(deps(), 'filament', 'main', { discard: true })).rejects.toThrow('merging')
})

test('removes merged branches that nobody changed or used for a week', async () => {
  const d = deps()
  const merged = (await createBranch(host, 'filament', 'merged')).sha
  recordBranchMerge(host, projectId, 'merged', merged)
  const used = (await createBranch(host, 'filament', 'used')).sha
  recordBranchMerge(host, projectId, 'used', used)
  const moved = (await createBranch(host, 'filament', 'moved')).sha
  recordBranchMerge(host, projectId, 'moved', moved)
  await seedBranch(host, 'filament', 'moved', { 'src/a.ts': 'export const a = 3\n' })
  await createBranch(host, 'filament', 'unmerged')

  // Recorded merges are a moment old; the cleanup runs as if a week passed.
  const later = Date.now() + 7 * DAY_MS + 1000
  await d.workspaces.open('filament', 'used')
  host.db.prepare(`UPDATE workspaces SET last_used_at = ? WHERE branch = 'used'`).run(new Date(later).toISOString())

  expect(await removeMergedBranches(d, Date.now())).toEqual([])
  expect(await removeMergedBranches(d, later)).toEqual(['filament/merged'])
  expect(await branchExists(host, 'filament', 'merged')).toBe(false)
  for (const branch of ['used', 'moved', 'unmerged']) expect(await branchExists(host, 'filament', branch)).toBe(true)
  expect([...branchMerges(host, projectId).keys()].sort()).toEqual(['moved', 'used'])
})

test('a new branch with the name of a merged one is not cleaned up', async () => {
  const sha = (await createBranch(host, 'filament', 'spools')).sha
  recordBranchMerge(host, projectId, 'spools', sha)
  await deleteBranch(deps(), 'filament', 'spools')
  recordBranchMerge(host, projectId, 'spools', sha)
  await createBranch(host, 'filament', 'spools')
  expect(branchMerges(host, projectId).has('spools')).toBe(false)
})
