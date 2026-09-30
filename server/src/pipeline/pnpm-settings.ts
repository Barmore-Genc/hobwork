import { parse } from 'yaml'

// In minutes. Set in the environment of every workspace and pipeline VM (see guest-vm.ts).
export const MIN_RELEASE_AGE_MINUTES = 4320

function normalize(key: string): string {
  return key.replace(/[-_]/g, '').toLowerCase()
}

function settings(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || !raw.trim()) return {}
  const doc: unknown = parse(raw)
  if (doc === null || doc === undefined) return {}
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('it must be a mapping of settings')
  return Object.fromEntries(Object.entries(doc).map(([key, value]) => [normalize(key), value]))
}

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)

// Returns the problems found, empty when the hob's pnpm-workspace.yaml keeps the
// image's install protections.
export function checkPnpmWorkspace(raw: string | undefined): string[] {
  return checkInstallConfig({ workspace: raw })
}

export type InstallConfig = {
  workspace?: string | undefined
  npmrc?: string | undefined
  // A pnpmfile at the hob's root (.pnpmfile.cjs or .pnpmfile.mjs) is code that runs during install.
  hasPnpmfile?: boolean
}

const PNPMFILE_SETTINGS = ['pnpmfile', 'globalpnpmfile']

function npmrcSettings(raw: string | undefined): Array<[string, string]> {
  if (!raw) return []
  const entries: Array<[string, string]> = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const eq = trimmed.indexOf('=')
    const key = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim()
    const value = eq === -1 ? '' : trimmed.slice(eq + 1).trim()
    entries.push([key, value])
  }
  return entries
}

// Settings that would undo the image's install protections. The pipeline and
// builds also run installs with --ignore-pnpmfile, so this is the readable
// failure for the same thing.
export function checkInstallConfig(files: InstallConfig): string[] {
  const problems = checkWorkspaceSettings(files.workspace)
  if (files.hasPnpmfile) {
    problems.push('.pnpmfile.cjs and .pnpmfile.mjs are not allowed: a pnpmfile runs code during install. Remove the file')
  }
  for (const [key, value] of npmrcSettings(files.npmrc)) {
    const name = normalize(key)
    if (PNPMFILE_SETTINGS.includes(name)) {
      problems.push(`.npmrc: ${key} is not allowed: a pnpmfile runs code during install. Remove the setting`)
    } else if (name === 'registry' || name.endsWith('registry')) {
      problems.push(`.npmrc: ${key} is not allowed: packages come from the registry the VM is configured with. Remove the setting`)
    } else if (name.startsWith('minimumreleaseage')) {
      const isAge = name === 'minimumreleaseage'
      const ok = isAge ? Number(value) >= MIN_RELEASE_AGE_MINUTES : name === 'minimumreleaseageignoremissingtime' ? value !== 'true' : false
      if (!ok) problems.push(`.npmrc: ${key} is not allowed. Remove the setting`)
    } else if (name === 'dangerouslyallowallbuilds' && value !== 'false') {
      problems.push('.npmrc: dangerously-allow-all-builds is not allowed. List the packages that need install scripts under allowBuilds')
    } else if (name === 'scriptshell' || name === 'nodeoptions' || name === 'nodeversion') {
      problems.push(`.npmrc: ${key} is not allowed. Remove the setting`)
    }
  }
  return problems
}

function checkWorkspaceSettings(raw: string | undefined): string[] {
  let config: Record<string, unknown>
  try {
    config = settings(raw)
  } catch (err) {
    return [`pnpm-workspace.yaml cannot be read: ${(err as Error).message}`]
  }
  const problems: string[] = []
  const age = config.minimumreleaseage
  if (age !== undefined && !(typeof age === 'number' && age >= MIN_RELEASE_AGE_MINUTES)) {
    problems.push(
      `pnpm-workspace.yaml: minimumReleaseAge must not be lower than ${MIN_RELEASE_AGE_MINUTES} (3 days). Remove the setting`,
    )
  }
  if (!isEmpty(config.minimumreleaseageexclude)) {
    problems.push('pnpm-workspace.yaml: minimumReleaseAgeExclude is not allowed. Remove the setting')
  }
  if (config.minimumreleaseageignoremissingtime === true) {
    problems.push('pnpm-workspace.yaml: minimumReleaseAgeIgnoreMissingTime is not allowed. Remove the setting')
  }
  if (!isEmpty(config.dangerouslyallowallbuilds) && config.dangerouslyallowallbuilds !== false) {
    problems.push(
      'pnpm-workspace.yaml: dangerouslyAllowAllBuilds is not allowed. List the packages that need install scripts under allowBuilds',
    )
  }
  for (const name of PNPMFILE_SETTINGS) {
    if (!isEmpty(config[name])) {
      problems.push(`pnpm-workspace.yaml: ${name === 'pnpmfile' ? 'pnpmfile' : 'globalPnpmfile'} is not allowed: a pnpmfile runs code during install. Remove the setting`)
    }
  }
  if (!isEmpty(config.registry) || !isEmpty(config.registries)) {
    problems.push('pnpm-workspace.yaml: registry and registries are not allowed. Remove the setting')
  }
  return problems
}

// Packages whose install scripts pnpm may run.
export function allowedBuilds(raw: string | undefined): string[] {
  let config: Record<string, unknown>
  try {
    config = settings(raw)
  } catch {
    return []
  }
  const allow = config.allowbuilds
  if (typeof allow !== 'object' || allow === null || Array.isArray(allow)) return []
  return Object.entries(allow)
    .filter(([, value]) => value === true)
    .map(([name]) => name)
    .sort()
}

export type AllowedBuildsChange = { added: string[]; removed: string[] }

export function allowedBuildsChange(before: string | undefined, after: string | undefined): AllowedBuildsChange {
  const was = new Set(allowedBuilds(before))
  const now = new Set(allowedBuilds(after))
  return {
    added: [...now].filter((name) => !was.has(name)),
    removed: [...was].filter((name) => !now.has(name)),
  }
}

// Undefined when the list did not change.
export function describeAllowedBuildsChange(before: string | undefined, after: string | undefined): string | undefined {
  const { added, removed } = allowedBuildsChange(before, after)
  if (!added.length && !removed.length) return undefined
  const lines = ['This version changes which packages may run install scripts (allowBuilds in pnpm-workspace.yaml):']
  if (added.length) lines.push(`  now allowed: ${added.join(', ')}`)
  if (removed.length) lines.push(`  no longer allowed: ${removed.join(', ')}`)
  return lines.join('\n')
}

// A frozen install fails with these codes when the lockfile is missing or does
// not match package.json.
export function explainFrozenInstallFailure(output: string): string | undefined {
  if (!/ERR_PNPM_\w*LOCKFILE\w*/.test(output)) return undefined
  return 'pnpm-lock.yaml is missing or does not match package.json. Run pnpm install in the workspace, then commit pnpm-lock.yaml'
}
