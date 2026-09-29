import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { AccessError, parseAccess } from '../access.ts'
import { createAgentToken } from '../agents.ts'
import { loadConfig } from '../config.ts'
import { openHostDb } from '../db.ts'

const USAGE = 'Usage: pnpm --filter @hobwork/server create-token <agent-name> [--read-only] [--project <name>]...'

let parsed
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { 'read-only': { type: 'boolean', default: false }, project: { type: 'string', multiple: true } },
  })
} catch (err) {
  console.error(`${(err as Error).message}\n${USAGE}`)
  process.exit(1)
}
const [name, ...extra] = parsed.positionals
if (!name || extra.length) {
  console.error(USAGE)
  process.exit(1)
}

const config = loadConfig()
const db = openHostDb(join(config.dataDir, 'hobwork.db'))
try {
  const access = parseAccess(db, { readOnly: parsed.values['read-only'], projects: parsed.values.project ?? null })
  console.log(createAgentToken(db, name, access).token)
} catch (err) {
  if (!(err instanceof AccessError)) throw err
  console.error(err.message)
  process.exitCode = 1
} finally {
  db.close()
}
