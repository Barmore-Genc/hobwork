import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureAgent } from '../agents.ts'
import { loadConfig } from '../config.ts'
import { openHostDb } from '../db.ts'
import { addSshKey, SshKeyError } from '../ssh/keys.ts'

const [name, file] = process.argv.slice(2)
if (!name) {
  console.error('Usage: pnpm --filter @hobwork/server add-ssh-key <agent-name> [public-key-file]')
  console.error('Without a file, the public key is read from stdin.')
  process.exit(1)
}

const publicKey = readFileSync(file ?? 0, 'utf8')
const config = loadConfig()
const db = openHostDb(join(config.dataDir, 'hobwork.db'))
try {
  const key = addSshKey(db, ensureAgent(db, name).id, publicKey)
  console.log(`Added ${key.algorithm} key ${key.fingerprint} for ${name}`)
} catch (err) {
  if (!(err instanceof SshKeyError)) throw err
  console.error(err.message)
  process.exitCode = 1
} finally {
  db.close()
}
