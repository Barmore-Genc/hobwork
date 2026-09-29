import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from '../config.ts'
import { openHostDb } from '../db.ts'
import { createSecretStore, loadSecretKey } from '../secrets.ts'

const USAGE = `Usage:
  pnpm --filter @hobwork/server secret list [<project> | --global]
  pnpm --filter @hobwork/server secret set (<project> | --global) <NAME> --host <host> [--host <host>...]
  pnpm --filter @hobwork/server secret delete (<project> | --global) <NAME>

set reads the value from stdin, e.g. printf %s "$KEY" | pnpm ... secret set filament API_KEY --host api.example.com
Leave stdin empty to change only the hosts of an existing secret.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { global: { type: 'boolean' }, host: { type: 'string', multiple: true } },
})
const [command, ...rest] = positionals
const scoped = values.global ? rest : rest.slice(1)
const project = values.global ? undefined : rest[0]

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

if (!command || (command !== 'list' && !values.global && !project)) fail(USAGE)

const config = loadConfig()
const db = openHostDb(join(config.dataDir, 'hobwork.db'))
try {
  const store = createSecretStore({ db, dataDir: config.dataDir }, loadSecretKey(config.dataDir, config.secretKey))
  if (command === 'list') {
    for (const secret of store.list(project)) console.log(`${secret.name}\t${secret.hosts.join(', ')}`)
  } else if (command === 'set') {
    const name = scoped[0] ?? fail(USAGE)
    const value = await readStdin()
    const { created } = store.set({ project, name, value: value || undefined, hosts: values.host })
    console.log(`${created ? 'Created' : 'Updated'} ${name}. Handlers and workspaces use the change from their next invocation or command.`)
  } else if (command === 'delete') {
    const name = scoped[0] ?? fail(USAGE)
    if (!store.remove(project, name)) fail(`There is no secret called ${name}`)
    console.log(`Deleted ${name}`)
  } else fail(USAGE)
} catch (err) {
  fail((err as Error).message)
} finally {
  db.close()
}
