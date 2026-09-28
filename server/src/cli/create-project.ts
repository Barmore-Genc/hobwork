import { join } from 'node:path'
import { loadConfig } from '../config.ts'
import { openHostDb } from '../db.ts'
import { createProject } from '../projects.ts'

const name = process.argv[2]
if (!name) {
  console.error('Usage: pnpm --filter @hobwork/server create-project <name>')
  process.exit(1)
}

const config = loadConfig()
const db = openHostDb(join(config.dataDir, 'hobwork.db'))
try {
  const project = await createProject({ db, dataDir: config.dataDir }, name)
  console.log(`Created ${project.name}: http://${config.host}:${config.port}/git/${project.name}.git`)
} finally {
  db.close()
}
