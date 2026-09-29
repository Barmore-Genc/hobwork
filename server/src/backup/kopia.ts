import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BackupConfig } from './config.ts'

export class KopiaError extends Error {}

export type SnapshotResult = {
  id: string
  totalBytes: number
  files: number
  // How much the repository grew. Kopia 0.17 does not report it, and its
  // progress output stops before the last packs are flushed.
  uploadedBytes?: number
}

export type SnapshotInfo = {
  id: string
  startTime: string
  endTime: string
  totalBytes: number
  files: number
  // Why retention keeps it, e.g. ["latest-1", "daily-1"].
  retention: string[]
}

// Snapshots are recorded as hobwork@hobwork instead of the machine's user and
// host name, so a host restored on another machine continues the same history.
const IDENTITY = ['--override-hostname', 'hobwork', '--override-username', 'hobwork']
const STATE_FILE = 'hobwork-state.json'
const TAIL_CHARS = 2000

// The total size of the repository's blobs from `kopia blob stats --raw`.
export function parseBlobTotal(stats: string): number | undefined {
  const match = /^Total: (\d+)$/m.exec(stats)
  return match ? Number(match[1]) : undefined
}

type Entry = {
  id: string
  startTime: string
  endTime: string
  rootEntry?: { summ?: { size?: number; files?: number; numFailed?: number } }
  retentionReason?: string[]
}

function parseJson<T>(stdout: string, what: string): T {
  const start = stdout.search(/[[{]/)
  try {
    return JSON.parse(stdout.slice(start)) as T
  } catch {
    throw new KopiaError(`Kopia's ${what} output is not JSON: ${stdout.slice(0, TAIL_CHARS)}`)
  }
}

// `dir` holds Kopia's config, cache and logs.
export function createKopia(config: BackupConfig, dir: string) {
  const configPath = join(dir, 'repository.config')
  const secrets = [config.password, config.secretAccessKey, config.accessKeyId].filter((s) => s.length >= 4)

  function redact(text: string): string {
    let out = text
    for (const secret of secrets) out = out.split(secret).join('[redacted]')
    return out
  }

  // Credentials go through the environment, so they never show up in the
  // process list.
  function env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      KOPIA_PASSWORD: config.password,
      AWS_ACCESS_KEY_ID: config.accessKeyId,
      AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
      KOPIA_CONFIG_PATH: configPath,
      KOPIA_CACHE_DIRECTORY: join(dir, 'cache'),
      KOPIA_LOG_DIR: join(dir, 'logs'),
      KOPIA_CHECK_FOR_UPDATES: 'false',
    }
  }

  function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return new Promise((resolve, reject) => {
      const child = spawn(config.kopiaBin, args, { env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
      child.on('error', (err: NodeJS.ErrnoException) => {
        reject(
          new KopiaError(
            err.code === 'ENOENT'
              ? `The kopia binary "${config.kopiaBin}" was not found. Install Kopia or set HOBWORK_KOPIA_BIN`
              : `Starting kopia failed: ${err.message}`,
          ),
        )
      })
      child.on('close', (code) => {
        const out = Buffer.concat(stdout).toString('utf8')
        const err = Buffer.concat(stderr).toString('utf8')
        if (code === 0) return resolve({ stdout: out, stderr: err })
        const detail = redact(err.replace(/\r/g, '\n').trim()).slice(-TAIL_CHARS)
        reject(new KopiaError(`kopia ${args.slice(0, 2).join(' ')} failed (exit ${code}): ${detail}`))
      })
    })
  }

  function storageArgs(): string[] {
    return [
      's3',
      '--bucket',
      config.bucket,
      '--endpoint',
      config.endpoint,
      '--prefix',
      config.prefix,
      ...(config.region ? ['--region', config.region] : []),
      ...(config.disableTls ? ['--disable-tls'] : []),
    ]
  }

  type State = { storage?: string; retention?: string }

  function readState(): State {
    try {
      return JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')) as State
    } catch {
      return {}
    }
  }

  function writeState(state: State) {
    writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(state)}\n`, { mode: 0o600 })
  }

  // Connects to the repository, and creates it when the bucket prefix is
  // empty unless `create` is false. Changing the storage settings connects again.
  async function ensureRepository({ create = true } = {}): Promise<void> {
    const storage = storageArgs()
    const key = JSON.stringify(storage)
    const state = readState()
    if (state.storage === key && existsSync(configPath)) return
    const connect = [...storage, '--no-persist-credentials', ...IDENTITY]
    try {
      await run(['repository', 'connect', ...connect])
    } catch (err) {
      if (!create || !(err instanceof KopiaError) || !err.message.includes('repository not initialized')) throw err
      await run(['repository', 'create', ...connect])
    }
    writeState({ storage: key })
  }

  async function applyRetention(): Promise<void> {
    const { daily, weekly, monthly } = config.retention
    const key = JSON.stringify(config.retention)
    const state = readState()
    if (state.retention === key) return
    await run([
      'policy',
      'set',
      '--global',
      '--keep-daily',
      String(daily),
      '--keep-weekly',
      String(weekly),
      '--keep-monthly',
      String(monthly),
      '--keep-hourly',
      '0',
      '--compression',
      'zstd-fastest',
    ])
    writeState({ ...state, retention: key })
  }

  async function storedBytes(): Promise<number | undefined> {
    const { stdout } = await run(['blob', 'stats', '--raw'])
    return parseBlobTotal(stdout)
  }

  return {
    configPath,
    ensureRepository,
    applyRetention,

    async snapshot(path: string): Promise<SnapshotResult> {
      const before = await storedBytes()
      const { stdout } = await run(['snapshot', 'create', path, '--json'])
      const entry = parseJson<Entry>(stdout, 'snapshot')
      const summary = entry.rootEntry?.summ
      if (summary?.numFailed) throw new KopiaError(`Kopia could not read ${summary.numFailed} files`)
      const after = await storedBytes()
      // Maintenance after the snapshot can delete a few index blobs.
      const uploadedBytes = before === undefined || after === undefined ? undefined : Math.max(0, after - before)
      return {
        id: entry.id,
        totalBytes: summary?.size ?? 0,
        files: summary?.files ?? 0,
        ...(uploadedBytes === undefined ? {} : { uploadedBytes }),
      }
    },

    // Oldest first.
    async list(): Promise<SnapshotInfo[]> {
      const { stdout } = await run(['snapshot', 'list', '--all', '--json'])
      return parseJson<Entry[]>(stdout, 'snapshot list')
        .map((e) => ({
          id: e.id,
          startTime: e.startTime,
          endTime: e.endTime,
          totalBytes: e.rootEntry?.summ?.size ?? 0,
          files: e.rootEntry?.summ?.files ?? 0,
          retention: e.retentionReason ?? [],
        }))
        .sort((a, b) => a.startTime.localeCompare(b.startTime))
    },

    // Checks that every snapshot's directories are readable, and reads back a
    // random sample of the files.
    async verify(filesPercent: number): Promise<string> {
      const { stdout, stderr } = await run(['snapshot', 'verify', `--verify-files-percent=${filesPercent}`])
      return `${stdout}${stderr}`.replace(/\r/g, '\n').trim()
    },

    async restore(snapshotId: string, target: string): Promise<void> {
      await run(['snapshot', 'restore', snapshotId, target, '--skip-owners'])
    },
  }
}

export type Kopia = ReturnType<typeof createKopia>
