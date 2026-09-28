import { join } from 'node:path'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { openHostDb } from './db.ts'
import { createDelivery } from './delivery.ts'
import { pipelineVmBackend, workspaceVmBackend, type GuestVmOptions } from './guest-vm.ts'
import { createHomeAssistant } from './homeassistant/client.ts'
import { repoPath, type Host } from './host.ts'
import { failInterruptedRuns } from './pipeline/runner.ts'
import { installHooks, listProjects } from './projects.ts'
import { createGondolinSandbox } from './sandbox/gondolin.ts'
import { imageDir, imageExists } from './sandbox/image.ts'
import { createWorkspaceManager, type ExecWorkspaceVm } from './workspaces.ts'

const config = loadConfig()
const host: Host = { db: openHostDb(join(config.dataDir, 'hobwork.db')), dataDir: config.dataDir }

// Keeps hooks current in repos created by an older host version.
for (const project of listProjects(host)) installHooks(repoPath(host, project.name))

const image = imageDir()
const vmOptions: GuestVmOptions | undefined = imageExists(image)
  ? { image, createSandbox: createGondolinSandbox, log: (message) => console.warn(message) }
  : undefined
if (vmOptions) console.log(`guest image: ${image}`)
else console.warn(`No guest image at ${image}, so bash and merge are unavailable. Build it with images/build.sh or set HOBWORK_IMAGE_DIR.`)
const pipelineVms = vmOptions && pipelineVmBackend(vmOptions)

const workspaces = createWorkspaceManager<ExecWorkspaceVm>(host, {
  startVm: vmOptions && workspaceVmBackend(vmOptions),
  idleTimeoutMs: config.workspaceIdleTimeoutMs,
})
workspaces.resetStatuses()
failInterruptedRuns(host)
const delivery = createDelivery(host, { workspaces, pipeline: pipelineVms && { startVm: pipelineVms.start } })

const homeAssistant = createHomeAssistant({ connection: () => config.homeAssistant })
homeAssistant.start()

const server = createApp(host, { workspaces, delivery, homeAssistant })

server.listen(config.port, config.host, () => {
  console.log(`hobwork host listening on http://${config.host}:${config.port}`)
})

async function shutdown() {
  homeAssistant.stop()
  await Promise.all([workspaces.stopAll(), pipelineVms?.stopAll()])
  server.close(() => {
    host.db.close()
    process.exit(0)
  })
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
