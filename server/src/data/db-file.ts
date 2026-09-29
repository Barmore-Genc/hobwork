import { closeSync, constants, fstatSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export class DbFileError extends Error {}

const SQLITE_MAGIC = 'SQLite format 3\0'
const CHUNK = 1024 * 1024

export function removeDbFiles(path: string) {
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true })
}

// Takes a DB file a VM wrote into a new file the host owns. The source is
// opened without following symlinks and must be a regular file (O_NONBLOCK
// keeps a FIFO from blocking the open), and the bytes are counted while they
// are copied, so a file cannot outgrow `maxBytes`. The copy is then opened
// and checked, so a corrupt DB is refused before it can replace a real one.
export function takeDbFile(source: string, dest: string, maxBytes: number): void {
  let input: number
  try {
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ELOOP') throw new DbFileError('The migrated DB is a symlink')
    if (code === 'ENOENT') throw new DbFileError('The migrated DB is missing')
    throw new DbFileError(`The migrated DB could not be opened: ${(err as Error).message}`)
  }
  let output: number | undefined
  try {
    const stat = fstatSync(input)
    if (!stat.isFile()) throw new DbFileError('The migrated DB is not a regular file')
    if (stat.size > maxBytes) {
      throw new DbFileError(`The migrated DB is ${stat.size} bytes, over the limit of ${maxBytes} bytes`)
    }
    output = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const buffer = Buffer.allocUnsafe(CHUNK)
    let total = 0
    let head = Buffer.alloc(0)
    for (;;) {
      const read = readSync(input, buffer, 0, CHUNK, null)
      if (read === 0) break
      total += read
      if (total > maxBytes) throw new DbFileError(`The migrated DB is over the limit of ${maxBytes} bytes`)
      if (head.length < SQLITE_MAGIC.length) head = Buffer.concat([head, buffer.subarray(0, read)])
      let written = 0
      while (written < read) written += writeSync(output, buffer, written, read - written)
    }
    if (head.subarray(0, SQLITE_MAGIC.length).toString('latin1') !== SQLITE_MAGIC) {
      throw new DbFileError('The migrated DB is not an SQLite database')
    }
  } catch (err) {
    if (output !== undefined) {
      closeSync(output)
      output = undefined
      removeDbFiles(dest)
    }
    throw err
  } finally {
    closeSync(input)
    if (output !== undefined) closeSync(output)
  }
  try {
    checkIntegrity(dest)
  } catch (err) {
    removeDbFiles(dest)
    throw err
  }
}

function checkIntegrity(path: string) {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path)
    db.enableDefensive(true)
    db.exec('PRAGMA trusted_schema = OFF')
    const rows = db.prepare('PRAGMA integrity_check').all()
    const problems = rows.map((row) => String(row.integrity_check)).filter((line) => line !== 'ok')
    if (problems.length) throw new DbFileError(`The migrated DB failed its integrity check: ${problems.slice(0, 3).join('; ')}`)
  } catch (err) {
    if (err instanceof DbFileError) throw err
    throw new DbFileError(`The migrated DB could not be checked: ${(err as Error).message}`)
  } finally {
    db?.close()
  }
  // The check may have created sidecar files for a DB whose header says WAL.
  for (const file of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(file, { force: true })
}
