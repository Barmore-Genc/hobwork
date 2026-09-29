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

// Undefined when the list did not change.
export function describeAllowedBuildsChange(before: string | undefined, after: string | undefined): string | undefined {
  const was = new Set(allowedBuilds(before))
  const now = new Set(allowedBuilds(after))
  const added = [...now].filter((name) => !was.has(name))
  const removed = [...was].filter((name) => !now.has(name))
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
