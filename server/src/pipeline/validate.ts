import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import { parseHobworkJson } from '../../../packages/sdk/src/hobwork-json.js'
import { isTimeZone } from '../../../packages/sdk/src/time.ts'
import { cpuShareProblem } from '../sandbox/cpu-quota.ts'
import { matchRoute, parseRoutes } from '../runtime/routes.ts'

const schemaPath = resolve(import.meta.dirname, '../../../packages/sdk/hobwork.schema.json')

let compiled: ValidateFunction | undefined

function validator(): ValidateFunction {
  compiled ??= new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync(schemaPath, 'utf8')))
  return compiled
}

function describe(error: ErrorObject): string {
  const at = error.instancePath || '(root)'
  const extra =
    error.keyword === 'additionalProperties'
      ? ` ("${(error.params as { additionalProperty: string }).additionalProperty}")`
      : error.keyword === 'const'
        ? ` (${JSON.stringify((error.params as { allowedValue: unknown }).allowedValue)})`
        : ''
  return `${at}: ${error.message ?? error.keyword}${extra}`
}

// Returns the problems found, empty when the file is valid.
export function validateHobworkJson(raw: string | undefined): string[] {
  if (raw === undefined) return ['hobwork.json is missing']
  let config: unknown
  try {
    config = parseHobworkJson(raw)
  } catch (err) {
    return [`hobwork.json cannot be parsed: ${(err as Error).message}`]
  }
  const validate = validator()
  if (validate(config)) return [...resourceProblems(config), ...timeZoneProblems(config), ...surfaceProblems(config)]
  // An "if" error only repeats the error inside its "then".
  return (validate.errors ?? []).filter((e) => e.keyword !== 'if').map(describe)
}

// A share of a core is only real where the host can cap the VM's CPU time.
function resourceProblems(config: unknown): string[] {
  const resources = (config as { resources?: Record<string, { cpus?: number }> }).resources ?? {}
  return Object.entries(resources).flatMap(([kind, { cpus }]) => {
    const problem = cpus === undefined ? undefined : cpuShareProblem(cpus)
    return problem === undefined ? [] : [`/resources/${kind}/cpus: ${problem}`]
  })
}

// The schema only checks the shape of a zone name; this host's Intl knows which exist.
function timeZoneProblems(config: unknown): string[] {
  const crons = (config as { crons?: Record<string, { timeZone?: string }> }).crons ?? {}
  return Object.entries(crons)
    .filter(([, cron]) => cron.timeZone !== undefined && cron.timeZone !== 'person' && !isTimeZone(cron.timeZone))
    .map(([name, cron]) => `/crons/${name}/timeZone: "${cron.timeZone}" is not a known time zone, such as "Europe/Istanbul"`)
}

type Surfaces = {
  routes?: Record<string, { handler: string }>
  widget?: { route: string }
  intents?: { id: string; route?: string; method?: string }[]
  share?: { id: string; route: string; upload?: string; accepts: { files?: string[] } }[]
  uploads?: Record<string, unknown>
}

// The widget, intents and share targets name routes by path, which only a route of
// hobwork.json can answer.
function surfaceProblems(config: unknown): string[] {
  const { routes, widget, intents = [], share = [], uploads = {} } = config as Surfaces
  const parsed = parseRoutes(routes)
  const answers = (method: string, path: string) => {
    const match = matchRoute(parsed, method, path.split('?')[0]!)
    return match !== undefined && 'route' in match
  }
  const problems: string[] = []
  if (widget && !answers('GET', widget.route)) problems.push(`/widget/route: no "GET" route in routes matches ${widget.route}`)
  const seen = new Set<string>()
  for (const [i, intent] of intents.entries()) {
    if (seen.has(intent.id)) problems.push(`/intents/${i}/id: "${intent.id}" is used twice`)
    seen.add(intent.id)
    const method = intent.method ?? 'POST'
    if (intent.route !== undefined && !answers(method, intent.route)) {
      problems.push(`/intents/${i}/route: no "${method}" route in routes matches ${intent.route}`)
    }
  }
  const targets = new Set<string>()
  for (const [i, target] of share.entries()) {
    if (targets.has(target.id)) problems.push(`/share/${i}/id: "${target.id}" is used twice`)
    targets.add(target.id)
    if (!answers('POST', target.route)) problems.push(`/share/${i}/route: no "POST" route in routes matches ${target.route}`)
    if (target.upload !== undefined && !(target.upload in uploads)) {
      problems.push(`/share/${i}/upload: there is no upload "${target.upload}" in uploads`)
    }
    if (target.accepts.files && target.upload === undefined) problems.push(`/share/${i}: a target that accepts files needs upload`)
  }
  return problems
}

export const VITE_CONFIG = `import { hobworkViteConfig } from '@hobwork/sdk/vite'

export default hobworkViteConfig()
`

// Projects created before comments were allowed have a vite.config.ts that
// reads hobwork.json with JSON.parse, so their build would fail with an
// unhelpful error.
export function checkViteConfig(hobworkJson: string | undefined, viteConfig: string | undefined): string | undefined {
  if (hobworkJson === undefined || viteConfig === undefined) return undefined
  if (!/JSON\.parse\(/.test(viteConfig) || !viteConfig.includes('hobwork.json')) return undefined
  try {
    JSON.parse(hobworkJson)
    return undefined
  } catch {
    return `hobwork.json has comments or trailing commas, but vite.config.ts reads it with JSON.parse. Replace vite.config.ts with:\n\n${VITE_CONFIG}`
  }
}
