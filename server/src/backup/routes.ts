import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Auth } from '../auth/auth.ts'
import type { Host } from '../host.ts'
import { json } from '../http.ts'
import { BackupBusyError, lastSuccessfulRun, listBackupRuns, type Backups } from './backups.ts'

const RUNS = 10

// GET /api/backups and POST /api/backups (back up now). Users only: agent
// tokens get 401 like on the other web API routes.
export function createBackupRoutes(options: { host: Host; auth: Auth; backups?: Backups }) {
  const { host, auth, backups } = options

  function status() {
    if (!backups) return { configured: false }
    const { config } = backups
    return {
      configured: true,
      destination: `${config.bucket}/${config.prefix}`,
      schedule: config.schedule ?? null,
      nextRun: backups.nextRun()?.toISOString() ?? null,
      retention: config.retention,
      running: backups.running(),
      lastSuccess: lastSuccessfulRun(host) ?? null,
      runs: listBackupRuns(host, RUNS),
    }
  }

  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    if (pathname !== '/api/backups') return false
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' }).end()
      return true
    }
    if (!auth.requireUser(req, res)) return true
    if (req.method === 'GET') {
      json(res, 200, status())
      return true
    }
    if (!backups) {
      json(res, 409, { error: 'Backups are not set up on this server' })
      return true
    }
    try {
      const { run } = backups.begin('manual')
      json(res, 202, run)
    } catch (err) {
      if (!(err instanceof BackupBusyError)) throw err
      json(res, 409, { error: err.message })
    }
    return true
  }
}
