import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import {
  allowedBuilds,
  checkInstallConfig,
  checkPnpmWorkspace,
  describeAllowedBuildsChange,
  explainFrozenInstallFailure,
  MIN_RELEASE_AGE_MINUTES,
} from './pnpm-settings.ts'

const root = resolve(import.meta.dirname, '../../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('the guest image sets no pnpm settings that allow install scripts', () => {
  const image = read('images/hobwork.json')
  expect(image).not.toMatch(/allowBuilds|dangerouslyAllowAllBuilds|onlyBuiltDependencies|allow-builds/i)
  expect(image).not.toMatch(/pnpm[^"]*config set/)
})

test('the project template passes the check and allows no install scripts', () => {
  const template = read('templates/project/pnpm-workspace.yaml')
  expect(checkPnpmWorkspace(template)).toEqual([])
  expect(allowedBuilds(template)).toEqual([])
})

test('accepts a missing or unrelated pnpm-workspace.yaml and a longer release age', () => {
  expect(checkPnpmWorkspace(undefined)).toEqual([])
  expect(checkPnpmWorkspace('')).toEqual([])
  expect(checkPnpmWorkspace('autoInstallPeers: false\nallowBuilds:\n  esbuild: true\n')).toEqual([])
  expect(checkPnpmWorkspace(`minimumReleaseAge: ${MIN_RELEASE_AGE_MINUTES * 2}\n`)).toEqual([])
})

test('refuses settings that lower the release age or allow every install script', () => {
  const refused = [
    'minimumReleaseAge: 0',
    'minimumReleaseAge: 100',
    "minimumReleaseAge: '0'",
    'minimum-release-age: 0',
    'minimumReleaseAge: false',
    'minimumReleaseAgeExclude:\n  - left-pad',
    'minimumReleaseAgeIgnoreMissingTime: true',
    'dangerouslyAllowAllBuilds: true',
    'dangerously_allow_all_builds: true',
  ]
  for (const yaml of refused) expect(checkPnpmWorkspace(`${yaml}\n`), yaml).not.toEqual([])
})

test('refuses a pnpm-workspace.yaml it cannot read', () => {
  expect(checkPnpmWorkspace('a: [')[0]).toContain('cannot be read')
  expect(checkPnpmWorkspace('- a\n')[0]).toContain('cannot be read')
})

test('lists the packages allowed to run install scripts', () => {
  expect(allowedBuilds('allowBuilds:\n  sharp: true\n  esbuild: true\n  ssh2: false\n')).toEqual(['esbuild', 'sharp'])
})

test('describes changes to the allowed packages', () => {
  const before = 'allowBuilds:\n  esbuild: true\n  sharp: true\n'
  const after = 'allowBuilds:\n  esbuild: true\n  core-js: true\n'
  expect(describeAllowedBuildsChange(before, before)).toBeUndefined()
  expect(describeAllowedBuildsChange(undefined, 'allowBuilds:\n  esbuild: false\n')).toBeUndefined()
  const message = describeAllowedBuildsChange(before, after)
  expect(message).toContain('now allowed: core-js')
  expect(message).toContain('no longer allowed: sharp')
})

test('explains lockfile failures of a frozen install', () => {
  expect(explainFrozenInstallFailure(' ERR_PNPM_NO_LOCKFILE  Cannot install')).toContain('commit pnpm-lock.yaml')
  expect(explainFrozenInstallFailure(' ERR_PNPM_OUTDATED_LOCKFILE  x')).toContain('commit pnpm-lock.yaml')
  expect(explainFrozenInstallFailure('ERR_PNPM_FETCH_404')).toBeUndefined()
})

test('refuses a pnpmfile and settings that point at one', () => {
  expect(checkInstallConfig({ hasPnpmfile: true })).not.toEqual([])
  for (const yaml of ['pnpmfile: ./x.cjs', 'globalPnpmfile: ./x.cjs', 'registry: https://evil.example']) {
    expect(checkInstallConfig({ workspace: `${yaml}\n` }), yaml).not.toEqual([])
  }
})

test('refuses .npmrc settings that undo install protections', () => {
  const refused = [
    'registry=https://evil.example',
    '@scope:registry=https://evil.example',
    'pnpmfile=./x.cjs',
    'minimum-release-age=0',
    'minimum-release-age-ignore-missing-time=true',
    'dangerously-allow-all-builds=true',
  ]
  for (const line of refused) expect(checkInstallConfig({ npmrc: `${line}\n` }), line).not.toEqual([])
  expect(checkInstallConfig({ npmrc: '# comment\nignore-scripts=false\nauto-install-peers=true\n' })).toEqual([])
  expect(checkInstallConfig({ npmrc: `minimum-release-age=${MIN_RELEASE_AGE_MINUTES}\n` })).toEqual([])
})
