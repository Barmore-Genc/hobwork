import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'

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
    config = JSON.parse(raw)
  } catch (err) {
    return [`hobwork.json is not valid JSON: ${(err as Error).message}`]
  }
  const validate = validator()
  if (validate(config)) return []
  return (validate.errors ?? []).map(describe)
}
