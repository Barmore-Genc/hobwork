import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from '../config.ts'
import { openHostDb } from '../db.ts'
import { createSecretStore, loadSecretKey, type Actor } from '../secrets.ts'

const USAGE = `Usage:
  pnpm --filter @hobwork/server secret list [<hob>]
  pnpm --filter @hobwork/server secret create "<name>" --host <host> [--host <host>...]
  pnpm --filter @hobwork/server secret update "<name>" [--host <host>...]
  pnpm --filter @hobwork/server secret delete "<name>"
  pnpm --filter @hobwork/server secret assign <hob> "<name>" <ENV_NAME>
  pnpm --filter @hobwork/server secret unassign <hob> <ENV_NAME>

create and update read the value from stdin, e.g.
  printf %s "$KEY" | pnpm ... secret create "Spoolman API key" --host api.example.com
Leave stdin empty on update to change only the hosts.`

const HOST: Actor = { kind: 'host' }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { host: { type: 'string', multiple: true } },
})
const [command, ...args] = positionals

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function arg(index: number): string {
  return args[index] ?? fail(USAGE)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

if (!command) fail(USAGE)

const APPLIES = 'Handlers and workspaces use the change from their next invocation or command.'

const config = loadConfig()
const db = openHostDb(join(config.dataDir, 'hobwork.db'))
try {
  const store = createSecretStore({ db, dataDir: config.dataDir }, loadSecretKey(config.dataDir, config.secretKey))
  if (command === 'list') {
    const project = args[0]
    if (project) {
      for (const secret of store.assigned(project)) console.log(`${secret.envName}\t${secret.secret}\t${secret.hosts.join(', ')}`)
    } else {
      for (const secret of store.list()) {
        const projects = secret.assignments.map((a) => `${a.project}:${a.envName}`).join(', ')
        console.log(`${secret.name}\t${secret.hosts.join(', ')}\t${projects}`)
      }
    }
  } else if (command === 'create') {
    const secret = store.create({ name: arg(0), value: await readStdin(), hosts: values.host ?? [] }, HOST)
    console.log(`Created "${secret.name}". Assign it to a hob with: secret assign <hob> "${secret.name}" <ENV_NAME>`)
  } else if (command === 'update') {
    const value = await readStdin()
    const secret = store.update(arg(0), { value: value || undefined, hosts: values.host }, HOST)
    console.log(`Updated "${secret.name}". ${APPLIES}`)
  } else if (command === 'delete') {
    if (!store.remove(arg(0), HOST)) fail(`There is no secret called "${arg(0)}"`)
    console.log(`Deleted "${arg(0)}"`)
  } else if (command === 'assign') {
    const assigned = store.assign(arg(0), arg(1), arg(2), HOST)
    console.log(`Assigned "${assigned.secret}" to ${arg(0)} as ${assigned.envName}. ${APPLIES}`)
  } else if (command === 'unassign') {
    if (!store.unassign(arg(0), arg(1), HOST)) fail(`${arg(0)} has no secret called ${arg(1)}`)
    console.log(`Unassigned ${arg(1)} from ${arg(0)}. ${APPLIES}`)
  } else fail(USAGE)
} catch (err) {
  fail((err as Error).message)
} finally {
  db.close()
}
