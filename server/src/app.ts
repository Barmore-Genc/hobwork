import type { DatabaseSync } from 'node:sqlite'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

type Project = { name: string; defaultBranch: string }

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function createApp(db: DatabaseSync): Server {
  const listProjects = db.prepare('SELECT name, default_branch FROM projects ORDER BY name')

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost')

    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && pathname === '/api/projects') {
      const projects: Project[] = listProjects
        .all()
        .map((row) => ({ name: String(row.name), defaultBranch: String(row.default_branch) }))
      return json(res, 200, projects)
    }
    json(res, 404, { error: 'not found' })
  })
}
