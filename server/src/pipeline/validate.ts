import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import { parseHobworkJson } from '../../../packages/sdk/src/hobwork-json.js'

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
  if (validate(config)) return []
  return (validate.errors ?? []).map(describe)
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
