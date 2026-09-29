import { CronError, parseCron } from '../runtime/cron.ts'

export type Retention = { daily: number; weekly: number; monthly: number }

export type BackupConfig = {
  kopiaBin: string
  // Kopia's --endpoint: host and optional port, without a scheme.
  endpoint: string
  disableTls: boolean
  bucket: string
  prefix: string
  region?: string
  accessKeyId: string
  secretAccessKey: string
  // Encrypts the Kopia repository. Without it, a restore is impossible.
  password: string
  // A cron expression in the host's local time, or undefined when only manual
  // backups run.
  schedule?: string
  retention: Retention
}

export const DEFAULT_SCHEDULE = '30 3 * * *'
export const DEFAULT_RETENTION: Retention = { daily: 14, weekly: 8, monthly: 12 }

function endpointOf(value: string): { endpoint: string; disableTls: boolean } {
  if (!/^[a-z]+:\/\//i.test(value)) return { endpoint: value, disableTls: false }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`HOBWORK_BACKUP_S3_ENDPOINT must be a host like s3.eu-central-1.amazonaws.com, got "${value}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`HOBWORK_BACKUP_S3_ENDPOINT must start with http:// or https://, got "${value}"`)
  }
  if (url.pathname !== '/' || url.search) {
    throw new Error(`HOBWORK_BACKUP_S3_ENDPOINT must not have a path, got "${value}". Put the path in HOBWORK_BACKUP_S3_PREFIX`)
  }
  return { endpoint: url.host, disableTls: url.protocol === 'http:' }
}

function keep(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name]
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of 0 or more, got "${value}"`)
  return n
}

// Backups are on when HOBWORK_BACKUP_S3_BUCKET is set.
export function loadBackupConfig(env: NodeJS.ProcessEnv): BackupConfig | undefined {
  const bucket = env.HOBWORK_BACKUP_S3_BUCKET
  if (!bucket) return undefined
  const missing = ['HOBWORK_BACKUP_S3_ACCESS_KEY_ID', 'HOBWORK_BACKUP_S3_SECRET_ACCESS_KEY', 'HOBWORK_BACKUP_PASSWORD'].filter(
    (name) => !env[name],
  )
  if (missing.length) throw new Error(`HOBWORK_BACKUP_S3_BUCKET is set, so ${missing.join(', ')} must be set too`)

  const scheduleValue = env.HOBWORK_BACKUP_SCHEDULE?.trim() || DEFAULT_SCHEDULE
  let schedule: string | undefined
  if (scheduleValue !== 'off') {
    try {
      parseCron(scheduleValue)
    } catch (err) {
      if (err instanceof CronError) throw new Error(`HOBWORK_BACKUP_SCHEDULE: ${err.message}`)
      throw err
    }
    schedule = scheduleValue
  }

  const prefix = env.HOBWORK_BACKUP_S3_PREFIX ?? 'hobwork/'
  return {
    kopiaBin: env.HOBWORK_KOPIA_BIN || 'kopia',
    ...endpointOf(env.HOBWORK_BACKUP_S3_ENDPOINT || 's3.amazonaws.com'),
    bucket,
    prefix,
    ...(env.HOBWORK_BACKUP_S3_REGION ? { region: env.HOBWORK_BACKUP_S3_REGION } : {}),
    accessKeyId: env.HOBWORK_BACKUP_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.HOBWORK_BACKUP_S3_SECRET_ACCESS_KEY!,
    password: env.HOBWORK_BACKUP_PASSWORD!,
    schedule,
    retention: {
      daily: keep(env, 'HOBWORK_BACKUP_KEEP_DAILY', DEFAULT_RETENTION.daily),
      weekly: keep(env, 'HOBWORK_BACKUP_KEEP_WEEKLY', DEFAULT_RETENTION.weekly),
      monthly: keep(env, 'HOBWORK_BACKUP_KEEP_MONTHLY', DEFAULT_RETENTION.monthly),
    },
  }
}
