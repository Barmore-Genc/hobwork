import { join } from 'node:path'
import { openRouterCatalog } from './ai/catalog.ts'
import { createAiGateway } from './ai/gateway.ts'
import { createApp } from './app.ts'
import { createAppOrigins } from './apps/origins.ts'
import { createBackups } from './backup/backups.ts'
import { loadConfig } from './config.ts'
import { openHostDb } from './db.ts'
import { migrationVmBackend } from './data/migration-vm.ts'
import { createProjectData } from './data/project-data.ts'
import { createWorkspaceEnvironment } from './data/workspace-environment.ts'
import { createDelivery } from './delivery.ts'
import { branchFileReader } from './files.ts'
import { createDevices } from './devices/devices.ts'
import { pipelineVmBackend, workspaceVmBackend, type GuestVmOptions } from './guest-vm.ts'
import { createHomeAssistant } from './homeassistant/client.ts'
import { backfillHaEvents, backfillHaServices } from './homeassistant/services.ts'
import { createHomeAssistantSettings } from './homeassistant/settings.ts'
import { createTriggerRegistry } from './homeassistant/triggers.ts'
import { repoPath, type Host } from './host.ts'
import { startHousekeeping } from './housekeeping.ts'
import { failInterruptedRuns } from './pipeline/runner.ts'
import { installHooks, listProjects } from './projects.ts'
import { homeAssistantClientLogger, triggerRegistryLogger } from './runtime/homeassistant.ts'
import { createRuntime } from './runtime/runtime.ts'
import { budgetedSandboxFactory } from './sandbox/budget.ts'
import { createGondolinSandbox } from './sandbox/gondolin.ts'
import { createVmScheduler } from './sandbox/scheduler.ts'
import { imageDir, imageExists } from './sandbox/image.ts'
import { checkIsolation } from './sandbox/isolation.ts'
import { createSecretStore, loadSecretKey } from './secrets.ts'
import { createSshGateway, loadHostKey } from './ssh/gateway.ts'
import { createStorageUsage } from './storage.ts'
import { createWorkspaceApi } from './workspace-api.ts'
import { createWorkspaceManager, type InteractiveWorkspaceVm, type WorkspaceManager } from './workspaces.ts'

const config = loadConfig()
const host: Host = { db: openHostDb(join(config.dataDir, 'hobwork.db')), dataDir: config.dataDir }

// Keeps hooks current in repos created by an older host version.
for (const project of listProjects(host)) installHooks(repoPath(host, project.name))

const secretKey = loadSecretKey(config.dataDir, config.secretKey)
const secrets = createSecretStore(host, secretKey)
const homeAssistantSettings = createHomeAssistantSettings({ db: host.db, key: secretKey, env: config.homeAssistant })
const data = createProjectData(host)
const aiConfig = { models: config.aiModels, catalog: openRouterCatalog() }
const ai = createAiGateway(host, aiConfig)
const devices = createDevices({
  host,
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

checkIsolation()
const image = imageDir()
const vmScheduler = createVmScheduler({
  ...config.vmBudget,
  reclaim: async ({ project, branch }) => (branch === undefined ? false : workspaces.stopIfIdle(project, branch)),
})
const vmOptions: GuestVmOptions | undefined = imageExists(image)
  ? {
      image,
      createSandbox: budgetedSandboxFactory(createGondolinSandbox, vmScheduler),
      log: (message) => console.warn(message),
      readBranchFile: branchFileReader(host),
      workspaceEnvironment: createWorkspaceEnvironment(host, { data, secrets, homeAssistant, devices, ai }),
    }
  : undefined
if (vmOptions) console.log(`guest image: ${image}`)
else console.warn(`No guest image at ${image}, so bash, merge and handlers are unavailable. Build it with images/build.sh or set HOBWORK_IMAGE_DIR.`)
const pipelineVms = vmOptions && pipelineVmBackend(vmOptions)
data.useMigrationVm(vmOptions && migrationVmBackend(vmOptions))

const workspaces: WorkspaceManager<InteractiveWorkspaceVm> = createWorkspaceManager<InteractiveWorkspaceVm>(host, {
  startVm:
    vmOptions &&
    workspaceVmBackend(
      vmOptions,
      (workspace) => workspaceApi(workspace),
      (workspace, token) => workspaces.sessionAgent(workspace.project, workspace.branch, token) !== undefined,
    ),
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
  ai,
})
const delivery = createDelivery(host, {
  workspaces,
  pipeline: pipelineVms && { startVm: pipelineVms.start, migrationDryRun: data.migrationDryRun },
  deploy: runtime.deploy,
})
const workspaceApi = createWorkspaceApi({ host, workspaces, delivery, runtime, appOrigin: createAppOrigins(config.appsUrl).origin })
await backfillHaServices(host)
await backfillHaEvents(host)
homeAssistant.start()
await runtime.start()
const housekeeping = startHousekeeping(host, { runtime, branches: { workspaces, delivery, runtime, data } })
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
    `Hob apps at ${config.appsUrl} are a different site from ${config.publicUrl}, so they cannot sign in inside the Hobwork UI. Use HOBWORK_PUBLIC_URL=http://hobwork.localhost:${config.port} instead.`,
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
  ai: aiConfig,
  sshPort: config.sshPort,
  web: {
    publicUrl: config.publicUrl,
    appsUrl: config.appsUrl,
    allowlist: config.allowlist,
    oidc: config.oidc,
    webDist: config.webDist,
    appleAppId: config.appleAppId,
    trustedProxies: config.trustedProxies,
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
