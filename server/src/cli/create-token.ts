import { join } from 'node:path'
import { createAgentToken } from '../agents.ts'
import { loadConfig } from '../config.ts'
import { openHostDb } from '../db.ts'

const name = process.argv[2]
if (!name) {
  console.error('Usage: pnpm --filter @hobwork/server create-token <agent-name>')
  process.exit(1)
}

const config = loadConfig()
const db = openHostDb(join(config.dataDir, 'hobwork.db'))
const { token } = createAgentToken(db, name)
db.close()
console.log(token)
