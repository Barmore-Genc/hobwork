import { afterEach, beforeEach, expect, test } from 'vitest'
import { createProject } from '../projects.ts'
import { createBranch } from '../repo.ts'
import { createTestHost } from '../test-host.ts'
import { appLabel, branchLabel, createAppOrigins, parseLabel } from './origins.ts'

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

let host: ReturnType<typeof createTestHost>

beforeEach(() => {
  host = createTestHost()
})

afterEach(() => host.dispose())

test('main is the project name; branches that are DNS labels keep their name', () => {
  expect(appLabel({ project: 'filament' })).toBe('filament')
  expect(appLabel({ project: 'filament', branch: 'main' })).toBe('filament')
  expect(appLabel({ project: 'filament', branch: 'add-spools' })).toBe('add-spools--filament')
  expect(parseLabel('add-spools--filament')).toEqual({ project: 'filament', branchLabel: 'add-spools' })
  expect(parseLabel('filament')).toEqual({ project: 'filament' })
})

test('other branch names get a readable prefix and a hash', () => {
  const cases = ['feature/Spools', 'Add_Spools', 'fix.v2', 'ui', 'xn', 'a', 'x'.repeat(100), '2026/09/28-night', 'a--b']
  const labels = cases.map((branch) => branchLabel('filament', branch)!)
  expect(labels[0]).toMatch(/^feature-spools-[0-9a-f]{6}$/)
  expect(labels[1]).toMatch(/^add-spools-[0-9a-f]{6}$/)
  // Two characters would put "--" at positions 3 and 4, which DNS reserves.
  expect(labels[3]).toMatch(/^ui-[0-9a-f]{6}$/)
  expect(new Set(labels).size).toBe(labels.length)
  for (const [i, label] of labels.entries()) {
    const full = appLabel({ project: 'filament', branch: cases[i] })!
    expect(full, cases[i]).toMatch(DNS_LABEL)
    expect(full.length, cases[i]).toBeLessThanOrEqual(63)
    expect(label, cases[i]).not.toContain('--')
    expect(full.slice(2, 4), cases[i]).not.toBe('--')
    expect(parseLabel(full)).toEqual({ project: 'filament', branchLabel: label })
  }
  // Similar names do not collide.
  expect(branchLabel('filament', 'feature/spools')).not.toBe(branchLabel('filament', 'feature-spools'))
  expect(branchLabel('filament', 'Feature')).not.toBe(branchLabel('filament', 'feature'))
})

test('labels fit in 63 characters for the longest project names', () => {
  const project = 'p'.repeat(40)
  for (const branch of ['add-spools', 'x'.repeat(21), 'x'.repeat(22), 'feature/very-long-branch-name-for-spools']) {
    const label = appLabel({ project, branch })!
    expect(label.length, branch).toBeLessThanOrEqual(63)
    expect(label, branch).toMatch(DNS_LABEL)
  }
  expect(appLabel({ project, branch: 'x'.repeat(21) })).toBe(`${'x'.repeat(21)}--${project}`)
  expect(appLabel({ project, branch: 'x'.repeat(22) })).toMatch(/^x{14}-[0-9a-f]{6}--p{40}$/)
})

test('origins and Host headers', async () => {
  const origins = createAppOrigins('https://apps.hobwork.example.com')
  expect(origins.origin({ project: 'filament' })).toBe('https://filament.apps.hobwork.example.com')
  expect(origins.origin({ project: 'filament', branch: 'add-spools' })).toBe(
    'https://add-spools--filament.apps.hobwork.example.com',
  )
  expect(origins.labelOf('filament.apps.hobwork.example.com')).toBe('filament')
  expect(origins.labelOf('Filament.Apps.Hobwork.Example.com:443')).toBe('filament')
  expect(origins.labelOf('apps.hobwork.example.com')).toBeUndefined()
  expect(origins.labelOf('a.b.apps.hobwork.example.com')).toBeUndefined()
  expect(origins.labelOf('hobwork.example.com')).toBeUndefined()
  expect(origins.labelOf('filament.apps.hobwork.example.com.evil.test')).toBeUndefined()
  expect(origins.labelOf(undefined)).toBeUndefined()

  const dev = createAppOrigins('http://apps.hobwork.localhost:7420')
  expect(dev.origin({ project: 'filament' })).toBe('http://filament.apps.hobwork.localhost:7420')

  await createProject(host, 'filament')
  await createBranch(host, 'filament', 'add-spools')
  await createBranch(host, 'filament', 'feature/Spools')
  expect(await origins.resolveBranch(host, 'filament', 'add-spools')).toBe('add-spools')
  expect(await origins.resolveBranch(host, 'filament', branchLabel('filament', 'feature/Spools')!)).toBe('feature/Spools')
  expect(await origins.resolveBranch(host, 'filament', 'main')).toBeUndefined()
  expect(await origins.resolveBranch(host, 'filament', 'nope')).toBeUndefined()
})
