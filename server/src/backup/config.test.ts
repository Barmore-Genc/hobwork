import { expect, test } from 'vitest'
import { DEFAULT_RETENTION, DEFAULT_SCHEDULE, loadBackupConfig } from './config.ts'

const REQUIRED = {
  HOBWORK_BACKUP_S3_BUCKET: 'backups',
  HOBWORK_BACKUP_S3_ACCESS_KEY_ID: 'AKIA1234',
  HOBWORK_BACKUP_S3_SECRET_ACCESS_KEY: 'secret-key',
  HOBWORK_BACKUP_PASSWORD: 'repo-password',
}

test('backups are off without a bucket', () => {
  expect(loadBackupConfig({})).toBeUndefined()
})

test('defaults', () => {
  expect(loadBackupConfig(REQUIRED)).toEqual({
    kopiaBin: 'kopia',
    endpoint: 's3.amazonaws.com',
    disableTls: false,
    bucket: 'backups',
    prefix: 'hobwork/',
    accessKeyId: 'AKIA1234',
    secretAccessKey: 'secret-key',
    password: 'repo-password',
    schedule: DEFAULT_SCHEDULE,
    retention: DEFAULT_RETENTION,
  })
})

test('credentials and the password are required with a bucket', () => {
  expect(() => loadBackupConfig({ HOBWORK_BACKUP_S3_BUCKET: 'b', HOBWORK_BACKUP_S3_ACCESS_KEY_ID: 'a' })).toThrow(
    'HOBWORK_BACKUP_S3_SECRET_ACCESS_KEY, HOBWORK_BACKUP_PASSWORD must be set too',
  )
})

test('endpoint as a host or a URL', () => {
  expect(loadBackupConfig({ ...REQUIRED, HOBWORK_BACKUP_S3_ENDPOINT: 's3.eu-central-003.backblazeb2.com' })).toMatchObject({
    endpoint: 's3.eu-central-003.backblazeb2.com',
    disableTls: false,
  })
  expect(loadBackupConfig({ ...REQUIRED, HOBWORK_BACKUP_S3_ENDPOINT: 'http://localhost:19000' })).toMatchObject({
    endpoint: 'localhost:19000',
    disableTls: true,
  })
  expect(loadBackupConfig({ ...REQUIRED, HOBWORK_BACKUP_S3_ENDPOINT: 'https://minio.lan/' })).toMatchObject({
    endpoint: 'minio.lan',
    disableTls: false,
  })
  expect(() => loadBackupConfig({ ...REQUIRED, HOBWORK_BACKUP_S3_ENDPOINT: 'https://minio.lan/bucket' })).toThrow(
    'HOBWORK_BACKUP_S3_PREFIX',
  )
})

test('schedule, retention and the rest', () => {
  const config = loadBackupConfig({
    ...REQUIRED,
    HOBWORK_KOPIA_BIN: '/usr/bin/kopia',
    HOBWORK_BACKUP_S3_PREFIX: 'host-a/',
    HOBWORK_BACKUP_S3_REGION: 'eu-central-1',
    HOBWORK_BACKUP_SCHEDULE: '0 4 * * *',
    HOBWORK_BACKUP_KEEP_DAILY: '7',
    HOBWORK_BACKUP_KEEP_MONTHLY: '0',
  })
  expect(config).toMatchObject({
    kopiaBin: '/usr/bin/kopia',
    prefix: 'host-a/',
    region: 'eu-central-1',
    schedule: '0 4 * * *',
    retention: { daily: 7, weekly: 8, monthly: 0 },
  })
  expect(loadBackupConfig({ ...REQUIRED, HOBWORK_BACKUP_SCHEDULE: 'off' })?.schedule).toBeUndefined()
  expect(() => loadBackupConfig({ ...REQUIRED, HOBWORK_BACKUP_SCHEDULE: '0 25 * * *' })).toThrow('HOBWORK_BACKUP_SCHEDULE')
  expect(() => loadBackupConfig({ ...REQUIRED, HOBWORK_BACKUP_KEEP_WEEKLY: '-1' })).toThrow('HOBWORK_BACKUP_KEEP_WEEKLY')
})
