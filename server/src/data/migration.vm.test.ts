import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { DbRequest } from '../../../packages/sdk/src/runner/protocol.ts'
import type { GuestVmOptions } from '../guest-vm.ts'
import { repoPath } from '../host.ts'
import { createProject } from '../projects.ts'
import { createGondolinSandbox } from '../sandbox/gondolin.ts'
import { imageDir, imageExists } from '../sandbox/image.ts'
import { createTestHost } from '../test-host.ts'
import { FAKE_PROJECT, seedMain, type Files } from '../test-project.ts'
import { migrationVmBackend } from './migration-vm.ts'
import { createProjectData, type ProjectData } from './project-data.ts'

const QUOTA_BYTES = 8 * 1024 * 1024
const SPOOLS = 'CREATE TABLE spools (id INTEGER PRIMARY KEY, color TEXT NOT NULL) STRICT;'

function sql(statement: string): DbRequest {
  return { statements: [{ sql: statement }], transaction: false }
}

// Boots real VMs, so it only runs with HOBWORK_VM_TESTS=1 (`pnpm test:vm`).
describe.runIf(process.env.HOBWORK_VM_TESTS === '1')('migrations in a VM', { timeout: 120_000 }, () => {
  let host: ReturnType<typeof createTestHost>
  let data: ProjectData

  beforeAll(async () => {
    const image = imageDir()
    if (!imageExists(image)) throw new Error(`no guest image at ${image}, run images/build.sh`)
    host = createTestHost()
    const vmOptions: GuestVmOptions = { image, createSandbox: createGondolinSandbox }
    const runMigration = migrationVmBackend(vmOptions)
    data = createProjectData(host, { runMigrationVm: (options) => runMigration({ ...options, quotaBytes: QUOTA_BYTES }) })
    await createProject(host, 'filament')
  })

  afterAll(async () => {
    await data?.stop()
    host?.dispose()
  })

  async function seed(migrations: Files): Promise<string> {
    return seedMain(host, 'filament', { ...FAKE_PROJECT, ...migrations })
  }

  test('deploy and the dry run migrate a copy in the VM, and ATTACH and VACUUM INTO stay in the VM', async () => {
    const stolen = `/tmp/hobwork-escape-${process.pid}-a.sqlite`
    const vacuumed = `/tmp/hobwork-escape-${process.pid}-b.sqlite`
    const first = await seed({ 'migrations/0001_spools.sql': SPOOLS })
    await data.migrate('filament', first)
    await data.execute({ project: 'filament' }, sql("INSERT INTO spools (color) VALUES ('red')"))

    // A migration can end its own transaction and then run anything.
    const escape = `COMMIT;\nATTACH DATABASE '${stolen}' AS other;\nCREATE TABLE IF NOT EXISTS other.t (a);\nBEGIN;\nALTER TABLE spools ADD COLUMN grams REAL;`
    const second = await seed({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0002_escape.sql': escape })
    const outcome = await data.dryRun({ project: 'filament', gitDir: repoPath(host, 'filament'), commit: second })
    expect(outcome, outcome.output).toMatchObject({ status: 'passed' })
    // The dry run applies each migration twice (empty DB, then the copy), and VACUUM INTO refuses to overwrite.
    const third = await seed({
      'migrations/0001_spools.sql': SPOOLS,
      'migrations/0002_escape.sql': escape,
      'migrations/0003_vacuum.sql': `COMMIT;\nVACUUM main INTO '${vacuumed}';\nBEGIN;\nCREATE TABLE scans (id INTEGER PRIMARY KEY) STRICT;`,
    })
    await data.migrate('filament', third)

    expect(existsSync(stolen)).toBe(false)
    expect(existsSync(vacuumed)).toBe(false)
    expect(await data.execute({ project: 'filament' }, sql('SELECT color, grams FROM spools'))).toMatchObject({
      results: [{ rows: [{ color: 'red', grams: null }] }],
    })
  })

  test('a migration that fails in the VM is reported and changes nothing', async () => {
    const commit = await seed({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0004_bad.sql': 'CREATE TABLE (' })
    await expect(data.migrate('filament', commit)).rejects.toThrow('0004_bad.sql failed')
    const outcome = await data.dryRun({ project: 'filament', gitDir: repoPath(host, 'filament'), commit })
    expect(outcome).toMatchObject({ status: 'failed', output: expect.stringContaining('On an empty DB: migrations/0004_bad.sql failed') })
    expect(await data.execute({ project: 'filament' }, sql('SELECT count(*) AS n FROM spools'))).toMatchObject({
      results: [{ rows: [{ n: 1 }] }],
    })
  })

  test('a migration cannot write past the quota of its directory', async () => {
    const fill =
      'CREATE TABLE blobs (b BLOB) STRICT;\nWITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) INSERT INTO blobs SELECT zeroblob(1000000) FROM n;'
    const commit = await seed({ 'migrations/0001_spools.sql': SPOOLS, 'migrations/0005_fill.sql': fill })
    const outcome = await data.dryRun({ project: 'filament', gitDir: repoPath(host, 'filament'), commit })
    expect(outcome).toMatchObject({ status: 'failed', output: expect.stringMatching(/full|ENOSPC|disk/i) })
  })
})
