import { join } from 'node:path'
import { createApp } from './app.ts'
import { createAppOrigins } from './apps/origins.ts'
import { createBackups } from './backup/backups.ts'
import { loadConfig } from './config.ts'
import { openHostDb } from './db.ts'
import { createProjectData } from './data/project-data.ts'
import { createWorkspaceEnvironment } from './data/workspace-environment.ts'
import { createDelivery } from './delivery.ts'
import { createApns, loadApnsKey } from './devices/apns.ts'
import { createDevices } from './devices/devices.ts'
import { pipelineVmBackend, workspaceVmBackend, type GuestVmOptions } from './guest-vm.ts'
import { createHomeAssistant } from './homeassistant/client.ts'
import { createHomeAssistantSettings } from './homeassistant/settings.ts'
import { createTriggerRegistry } from './homeassistant/triggers.ts'
import { repoPath, type Host } from './host.ts'
import { startHousekeeping } from './housekeeping.ts'
import { failInterruptedRuns } from './pipeline/runner.ts'
import { installHooks, listProjects } from './projects.ts'
import { homeAssistantClientLogger, triggerRegistryLogger } from './runtime/homeassistant.ts'
import { createRuntime } from './runtime/runtime.ts'
import { createGondolinSandbox } from './sandbox/gondolin.ts'
import { imageDir, imageExists } from './sandbox/image.ts'
import { createSecretStore, loadSecretKey } from './secrets.ts'
import { createSshGateway, loadHostKey } from './ssh/gateway.ts'
import { createStorageUsage } from './storage.ts'
import { createWorkspaceApi } from './workspace-api.ts'
import { createWorkspaceManager, type InteractiveWorkspaceVm } from './workspaces.ts'

const config = loadConfig()
const host: Host = { db: openHostDb(join(config.dataDir, 'hobwork.db')), dataDir: config.dataDir }

// Keeps hooks current in repos created by an older host version.
for (const project of listProjects(host)) installHooks(repoPath(host, project.name))

const secretKey = loadSecretKey(config.dataDir, config.secretKey)
const secrets = createSecretStore(host, secretKey)
const homeAssistantSettings = createHomeAssistantSettings({ db: host.db, key: secretKey, env: config.homeAssistant })
const data = createProjectData(host)
const apns = config.apns && createApns({ key: loadApnsKey(config.apns.keyFile), keyId: config.apns.keyId, teamId: config.apns.teamId })
if (!apns) console.warn('HOBWORK_APNS_KEY_FILE is not set, so notifications only reach devices while the Hobwork app is connected.')
const devices = createDevices({
  host,
  apns,
  allowlist: config.allowlist,
  publicUrl: config.publicUrl,
  triggers: async (project) => (await runtime.config(project)).config.triggers,
  invokeTrigger: (project, name, payload) => runtime.invoke(project, { kind: 'trigger', name, manual: false, payload }),
})
const homeAssistant = createHomeAssistant({
  connection: () => homeAssistantSettings.connection(),
  logger: homeAssistantClientLogger(host, () =>
    listProjects(host).map((p) => p.name).filter((name) => triggers.active(name).length > 0)),
})

const image = imageDir()
const vmOptions: GuestVmOptions | undefined = imageExists(image)
  ? {
      image,
      createSandbox: createGondolinSandbox,
      log: (message) => console.warn(message),
      workspaceEnvironment: createWorkspaceEnvironment(host, { data, secrets, homeAssistant, devices }),
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
  devices,
  data,
  secrets,
})
const delivery = createDelivery(host, {
  workspaces,
  pipeline: pipelineVms && { startVm: pipelineVms.start, migrationDryRun: data.migrationDryRun },
  deploy: runtime.deploy,
})
const workspaceApi = createWorkspaceApi({ host, workspaces, delivery, runtime, appOrigin: createAppOrigins(config.appsUrl).origin })
homeAssistant.start()
await runtime.start()
const housekeeping = startHousekeeping(host, runtime)
const storage = createStorageUsage(host)
void storage.measureAll(listProjects(host))

if (!config.allowlist.everyone && !config.allowlist.emails.length && !config.allowlist.subjects.length) {
  console.warn('HOBWORK_ALLOWED_USERS is empty, so nobody can sign in to the web UI.')
} else if (!config.oidc) {
  console.warn(
    'HOBWORK_OIDC_ISSUER is not set, so people sign in with passkeys only. Enroll the first one with "pnpm --filter @hobwork/server sign-in-link <email>".',
  )
}

const backups = config.backup && createBackups(host, config.backup)
if (backups) backups.schedule()
else console.warn('HOBWORK_BACKUP_S3_BUCKET is not set, so nothing is backed up.')

if (new URL(config.publicUrl).hostname === 'localhost') {
  console.warn(
    `Project apps at ${config.appsUrl} are a different site from ${config.publicUrl}, so they cannot sign in inside the Hobwork UI. Use HOBWORK_PUBLIC_URL=http://hobwork.localhost:${config.port} instead.`,
  )
}

const server = createApp(host, {
  workspaces,
  delivery,
  homeAssistant,
  homeAssistantSettings,
  runtime,
  data,
  secrets,
  storage,
  backups,
  devices,
  sshPort: config.sshPort,
  web: {
    publicUrl: config.publicUrl,
    appsUrl: config.appsUrl,
    allowlist: config.allowlist,
    oidc: config.oidc,
    webDist: config.webDist,
    appleAppId: config.appleAppId,
  },
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
  devices.close()
  backups?.stop()
  housekeeping.stop()
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
