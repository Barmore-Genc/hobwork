import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createSignInLink, LINK_TTL_MINUTES } from '../auth/links.ts'
import { findOrCreateEmailUser } from '../auth/users.ts'
import { loadConfig } from '../config.ts'
import { openHostDb } from '../db.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: 'string' } } })
const email = positionals[0]
if (!email) {
  console.error('Usage: pnpm --filter @hobwork/server sign-in-link <email> [--name "Full Name"]')
  process.exit(1)
}

const config = loadConfig()
const db = openHostDb(join(config.dataDir, 'hobwork.db'))
try {
  const user = findOrCreateEmailUser(db, config.allowlist, email, values.name)
  if (!user) {
    console.error(`${email} is not in HOBWORK_ALLOWED_USERS. Add it there first.`)
    process.exitCode = 1
  } else {
    console.log(createSignInLink(db, config.publicUrl, user.id))
    console.error(
      `Open the link within ${LINK_TTL_MINUTES} minutes to sign in as ${user.name}, then add a passkey in Settings. It works once.`,
    )
  }
} finally {
  db.close()
}
