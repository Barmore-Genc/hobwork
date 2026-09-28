import { join } from 'node:path'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { openHostDb } from './db.ts'
import { createDelivery } from './delivery.ts'
import { repoPath, type Host } from './host.ts'
import { failInterruptedRuns } from './pipeline/runner.ts'
import { installHooks, listProjects } from './projects.ts'
import { createWorkspaceManager, type ExecWorkspaceVm } from './workspaces.ts'

const config = loadConfig()
const host: Host = { db: openHostDb(join(config.dataDir, 'hobwork.db')), dataDir: config.dataDir }

// Keeps hooks current in repos created by an older host version.
for (const project of listProjects(host)) installHooks(repoPath(host, project.name))
// No VM backend until the sandbox layer is wired in, so bash reports that it is unavailable.
const workspaces = createWorkspaceManager<ExecWorkspaceVm>(host)
workspaces.resetStatuses()
failInterruptedRuns(host)
// No pipeline VM backend until the sandbox layer is wired in, so merge reports
// that it is unavailable. The host backend in pipeline/host-backend.ts runs
// project code unsandboxed and must never be used here.
const delivery = createDelivery(host, { workspaces })

const server = createApp(host, { workspaces, delivery })

server.listen(config.port, config.host, () => {
  console.log(`hobwork host listening on http://${config.host}:${config.port}`)
})

function shutdown() {
  server.close(() => {
    host.db.close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
