import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type FakeKopiaCall = { args: string[]; env: Record<string, string | undefined>; staged?: string[] }

// A stand-in for the kopia binary: records each call with its environment,
// and answers like Kopia 0.17 does. `failSnapshot` makes snapshots fail with
// the repository password in the error output.
export function createFakeKopia(dir: string) {
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'kopia.mjs')
  const calls = join(dir, 'calls.jsonl')
  const state = join(dir, 'state.json')
  writeFileSync(state, JSON.stringify({ initialized: false, failSnapshot: false, stored: 1000 }))
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'))
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith('KOPIA_') || k.startsWith('AWS_')),
)
const call = { args, env }
const [group, command] = args
if (group === 'snapshot' && command === 'create') call.staged = readdirSync(args[2], { recursive: true }).sort()
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(call) + '\\n')
function connected() {
  mkdirSync(dirname(process.env.KOPIA_CONFIG_PATH), { recursive: true })
  writeFileSync(process.env.KOPIA_CONFIG_PATH, '{}')
}
const entry = (id, start) => ({
  id,
  source: { host: 'hobwork', userName: 'hobwork', path: '/data/backup-staging' },
  startTime: start,
  endTime: start,
  rootEntry: { name: 'backup-staging', type: 'd', summ: { size: 1234, files: 5, dirs: 3, numFailed: 0 } },
})
if (group === 'repository' && command === 'connect') {
  if (!state.initialized) {
    process.stderr.write('ERROR error connecting to repository: repository not initialized in the provided storage\\n')
    process.exit(1)
  }
  connected()
} else if (group === 'repository' && command === 'create') {
  state.initialized = true
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(state))
  connected()
} else if (group === 'snapshot' && command === 'create') {
  if (state.failSnapshot) {
    process.stderr.write('ERROR upload failed for password ' + process.env.KOPIA_PASSWORD + '\\n')
    process.exit(1)
  }
  state.stored += 1500000
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(state))
  process.stderr.write(' * 0 hashing, 5 hashed (1.2 KB), 0 cached (0 B), uploaded 1.2 KB, estimating...\\n')
  process.stdout.write(JSON.stringify(entry('snap2', '2026-09-28T03:30:00Z')) + '\\n')
} else if (group === 'blob' && command === 'stats') {
  process.stdout.write('Count: 3\\nTotal: ' + state.stored + '\\nAverage: 1\\n')
} else if (group === 'snapshot' && command === 'list') {
  process.stdout.write(JSON.stringify([
    { ...entry('snap2', '2026-09-28T03:30:00Z'), retentionReason: ['latest-1', 'daily-1'] },
    { ...entry('snap1', '2026-09-27T03:30:00Z'), retentionReason: ['latest-2'] },
  ]))
} else if (group === 'snapshot' && command === 'verify') {
  process.stdout.write('Processed 5 objects.\\n')
} else if (group === 'snapshot' && command === 'restore') {
  mkdirSync(args[3], { recursive: true })
  writeFileSync(args[3] + '/hobwork.db', '')
} else if (group !== 'policy') {
  process.stderr.write('unknown command\\n')
  process.exit(1)
}
`,
  )
  chmodSync(bin, 0o755)

  return {
    bin,
    calls(): FakeKopiaCall[] {
      if (!existsSync(calls)) return []
      return readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as FakeKopiaCall)
    },
    set(values: { initialized?: boolean; failSnapshot?: boolean }) {
      writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), ...values }))
    },
  }
}

export type FakeKopia = ReturnType<typeof createFakeKopia>
