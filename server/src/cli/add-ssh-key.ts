import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureAgent } from '../agents.ts'
import { loadConfig } from '../config.ts'
import { openHostDb } from '../db.ts'
import { addSshKey, SshKeyError } from '../ssh/keys.ts'

const [agentName, keyName, file] = process.argv.slice(2)
if (!agentName || !keyName) {
  console.error('Usage: pnpm --filter @hobwork/server add-ssh-key <agent-name> <key-name> [public-key-file]')
  console.error('Without a file, the public key is read from stdin.')
  process.exit(1)
}

const publicKey = readFileSync(file ?? 0, 'utf8')
const config = loadConfig()
const db = openHostDb(join(config.dataDir, 'hobwork.db'))
try {
  const key = addSshKey(db, ensureAgent(db, agentName).id, keyName, publicKey, { via: 'host' })
  console.log(`Added ${key.algorithm} key "${key.name}" ${key.fingerprint} for ${agentName}`)
} catch (err) {
  if (!(err instanceof SshKeyError)) throw err
  console.error(err.message)
  process.exitCode = 1
} finally {
  db.close()
}
