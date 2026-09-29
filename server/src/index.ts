import { join } from 'node:path'
import { createApp } from './app.ts'
import { createBackups } from './backup/backups.ts'
import { loadConfig } from './config.ts'
import { openHostDb } from './db.ts'
import { createProjectData } from './data/project-data.ts'
import { createWorkspaceEnvironment } from './data/workspace-environment.ts'
import { createDelivery } from './delivery.ts'
import { pipelineVmBackend, workspaceVmBackend, type GuestVmOptions } from './guest-vm.ts'
import { createHomeAssistant } from './homeassistant/client.ts'
import { createTriggerRegistry } from './homeassistant/triggers.ts'
import { repoPath, type Host } from './host.ts'
import { failInterruptedRuns } from './pipeline/runner.ts'
import { installHooks, listProjects } from './projects.ts'
import { homeAssistantClientLogger, triggerRegistryLogger } from './runtime/homeassistant.ts'
import { createRuntime } from './runtime/runtime.ts'
import { createGondolinSandbox } from './sandbox/gondolin.ts'
import { imageDir, imageExists } from './sandbox/image.ts'
import { createSecretStore, loadSecretKey } from './secrets.ts'
import { createSshGateway, loadHostKey } from './ssh/gateway.ts'
import { createWorkspaceApi } from './workspace-api.ts'
import { createWorkspaceManager, type InteractiveWorkspaceVm } from './workspaces.ts'

const config = loadConfig()
const host: Host = { db: openHostDb(join(config.dataDir, 'hobwork.db')), dataDir: config.dataDir }

// Keeps hooks current in repos created by an older host version.
for (const project of listProjects(host)) installHooks(repoPath(host, project.name))

const secrets = createSecretStore(host, loadSecretKey(config.dataDir, config.secretKey))
const data = createProjectData(host)
const homeAssistant = createHomeAssistant({
  connection: () => config.homeAssistant,
  logger: homeAssistantClientLogger(host, () =>
    listProjects(host).map((p) => p.name).filter((name) => triggers.active(name).length > 0)),
})

const image = imageDir()
const vmOptions: GuestVmOptions | undefined = imageExists(image)
  ? {
      image,
      createSandbox: createGondolinSandbox,
      log: (message) => console.warn(message),
      workspaceEnvironment: createWorkspaceEnvironment(host, { data, secrets, homeAssistant }),
    }
  : undefined
if (vmOptions) console.log(`guest image: ${image}`)
else console.warn(`No guest image at ${image}, so bash, merge and handlers are unavailable. Build it with images/build.sh or set HOBWORK_IMAGE_DIR.`)
const pipelineVms = vmOptions && pipelineVmBackend(vmOptions)

const workspaces = createWorkspaceManager<InteractiveWorkspaceVm>(host, {
  startVm: vmOptions && workspaceVmBackend(vmOptions, (workspace) => workspaceApi(workspace)),
  idleTimeoutMs: config.workspaceIdleTimeoutMs,
})
workspaces.resetStatuses()
failInterruptedRuns(host)

const triggers = createTriggerRegistry({
  ha: homeAssistant,
  invoke: async (project, name, variables) => {
    await runtime.invoke(project, { kind: 'trigger', name, manual: false, payload: variables })
  },
  logger: triggerRegistryLogger(host),
})
const runtime = createRuntime(host, {
  createSandbox: vmOptions?.createSandbox,
  image: vmOptions?.image,
  startBuildVm: pipelineVms?.start,
  revert: (request) => delivery.restore(request),
  triggers,
  homeAssistant,
  data,
  secrets,
})
const delivery = createDelivery(host, {
  workspaces,
  pipeline: pipelineVms && { startVm: pipelineVms.start, migrationDryRun: data.migrationDryRun },
  deploy: runtime.deploy,
})
const workspaceApi = createWorkspaceApi({ host, workspaces, delivery, runtime })
homeAssistant.start()
await runtime.start()

if (!config.allowlist.emails.length && !config.allowlist.subjects.length) {
  console.warn('HOBWORK_ALLOWED_USERS is empty, so nobody can sign in to the web UI.')
} else if (!config.oidc) {
  console.warn(
    'HOBWORK_OIDC_ISSUER is not set, so people sign in with passkeys only. Enroll the first one with "pnpm --filter @hobwork/server sign-in-link <email>".',
  )
}

const backups = config.backup && createBackups(host, config.backup)
if (backups) backups.schedule()
else console.warn('HOBWORK_BACKUP_S3_BUCKET is not set, so nothing is backed up.')

const server = createApp(host, {
  workspaces,
  delivery,
  homeAssistant,
  runtime,
  data,
  secrets,
  backups,
  web: { publicUrl: config.publicUrl, allowlist: config.allowlist, oidc: config.oidc, webDist: config.webDist },
})

server.listen(config.port, config.host, () => {
  console.log(`hobwork host listening on http://${config.host}:${config.port}`)
})

const sshPort = config.sshPort
const ssh = sshPort === undefined ? undefined : createSshGateway({ host, workspaces, hostKey: loadHostKey(config.dataDir) })
ssh?.listen(sshPort, config.host, () => {
  console.log(`SSH gateway listening on ${config.host}:${sshPort}`)
})

async function shutdown() {
  homeAssistant.stop()
  backups?.stop()
  ssh?.close()
  await Promise.all([workspaces.stopAll(), pipelineVms?.stopAll(), runtime.stop()])
  await data.stop()
  server.close(() => {
    host.db.close()
    process.exit(0)
  })
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
