import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  InvokeRequest,
  InvokeResult,
  LogBatch,
  SerializedRequest,
  SerializedResponse,
} from '../../../packages/sdk/src/runner/protocol.ts'
import { RUNNER_PORT } from '../../../packages/sdk/src/runner/protocol.ts'
import { dbResponse } from '../data/internal.ts'
import type { ProjectData } from '../data/project-data.ts'
import type { Deployment } from '../delivery.ts'
import type { HomeAssistant } from '../homeassistant/client.ts'
import { haResponse } from '../homeassistant/internal.ts'
import type { TriggerRegistry } from '../homeassistant/triggers.ts'
import { repoPath, type Host } from '../host.ts'
import type { StartPipelineVm } from '../pipeline/runner.ts'
import { listProjects, ProjectError } from '../projects.ts'
import type { Sandbox, SandboxFactory } from '../sandbox/sandbox.ts'
import type { SecretStore } from '../secrets.ts'
import { listVersions } from '../versions.ts'
import { createDeployHealth, DEFAULT_AUTO_REVERT_POLICY, type AutoRevertPolicy, type DeployHealth } from './auto-revert.ts'
import { buildDir, createBuilder, treeOf } from './builds.ts'
import { allHandlers, entriesOf, readProjectConfig, type ProjectConfig } from './config.ts'
import {
  appendLog,
  appendLogs,
  failInterruptedInvocations,
  finishInvocation,
  pruneLogs,
  startInvocation,
  type InvocationKind,
  type LifecycleEvent,
  type LogLevel,
  type NewLogEntry,
} from './logs.ts'
import { parseRoutes, type Route } from './routes.ts'
import { createScheduler, type ScheduledCron } from './scheduler.ts'

// Guest paths. The build and the runner are mounted read-only. The runner
// comes from the host rather than the image because it speaks the host's
// protocol, and outside node_modules Node runs its TypeScript directly.
const APP_DIR = '/app'
const RUNNER_DIR = '/opt/hobwork/runner'
const HOST_RUNNER_DIR = resolve(import.meta.dirname, '../../../packages/sdk/src/runner')

const DEFAULT_INVOCATION_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_READY_TIMEOUT_MS = 60 * 1000
const MAX_LINES_PER_INVOCATION = 1000
const MAX_INTERNAL_BODY_BYTES = 5 * 1024 * 1024
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
const OUTPUT_TAIL_LINES = 30
const INTERNAL_ROUTES = new Set(['POST /v1/logs', 'POST /v1/db', 'POST /v1/ha'])

export type RuntimeOptions = {
  // Without it, invocations fail with an explanation; logs, crons and deploy
  // bookkeeping still work.
  createSandbox?: SandboxFactory
  image?: string
  // Builds versions that have no stored build.
  startBuildVm?: StartPipelineVm
  // Restores a version (delivery.restore), used by auto-revert.
  revert?: (request: { project: string; version: number; summary: string }) => Promise<unknown>
  triggers?: TriggerRegistry
  // Answers ctx.ha calls from handlers.
  homeAssistant?: HomeAssistant
  // Project DBs for handlers (ctx.db) and migrations on deploy.
  data?: ProjectData
  // Secrets handed to runtime VMs as placeholders. Their hosts join the egress allowlist.
  secrets?: SecretStore
  autoRevert?: AutoRevertPolicy
  invocationTimeoutMs?: number
  readyTimeoutMs?: number
  memory?: string
}

export type InvokeInput = {
  kind: InvocationKind
  name: string
  manual: boolean
  request?: SerializedRequest
  params?: Record<string, string>
  payload?: unknown
}

export type InvokeOutcome = {
  invocationId: number
  version: number | null
  durationMs: number
} & ({ ok: true; response: SerializedResponse } | { ok: false; error: { name: string; message: string; stack?: string } })

type Deployed = {
  version: number | null
  commit: string
  config: ProjectConfig
  routes: Route[]
  reason: Deployment['reason'] | 'current'
  health?: DeployHealth
  reverting?: boolean
}

type Instance = {
  deployed: Deployed
  // Secrets are fixed when a VM starts, so a change starts a new one.
  secretsFingerprint: string
  sandbox: Sandbox
  url: string
  inflight: Set<number>
  lines: Map<number, number>
  stopping: boolean
  idleTimer?: NodeJS.Timeout
  onIdle: (() => void)[]
}

type ProjectState = {
  deployed?: Deployed
  loading?: Promise<Deployed>
  instance?: Instance
  starting?: { deployed: Deployed; secretsFingerprint: string; promise: Promise<Instance> }
}

class RuntimeUnavailable extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createRuntime(host: Host, options: RuntimeOptions = {}) {
  const invocationTimeoutMs = options.invocationTimeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const policy = options.autoRevert ?? DEFAULT_AUTO_REVERT_POLICY
  const builder = createBuilder(host, options.startBuildVm)
  const projects = new Map<string, ProjectState>()
  const scheduler = createScheduler((project, name) => {
    void invoke(project, { kind: 'cron', name, manual: false }).catch((err: unknown) =>
      event(project, 'error', 'crash', `Cron "${name}" could not run: ${errorMessage(err)}`),
    )
  })
  let pruneTimer: NodeJS.Timeout | undefined

  function state(project: string): ProjectState {
    let s = projects.get(project)
    if (!s) projects.set(project, (s = {}))
    return s
  }

  function event(project: string, level: LogLevel, kind: LifecycleEvent, message: string) {
    try {
      appendLog(host, { project, source: 'runtime', level, event: kind, message })
    } catch (err) {
      console.error(`Could not record a runtime event for ${project}: ${message}`, err)
    }
  }

  // What runs is the newest version on main. Only a deploy changes it, but after
  // a host restart it is read back from the versions table.
  async function deployment(project: string): Promise<Deployed> {
    const s = state(project)
    if (s.deployed) return s.deployed
    s.loading ??= (async () => {
      const [latest] = listVersions(host, project, 1)
      if (!latest) throw new ProjectError(`${project} has no deployed version`)
      const config = await readProjectConfig(host, project, latest.commit)
      const deployed: Deployed = {
        version: latest.number,
        commit: latest.commit,
        config,
        routes: parseRoutes(config.routes),
        reason: 'current',
      }
      s.deployed ??= deployed
      return s.deployed
    })().finally(() => {
      s.loading = undefined
    })
    return s.loading
  }

  async function applyEntryPoints(project: string, deployed: Deployed) {
    for (const problem of scheduler.set(project, deployed.config.crons)) {
      event(project, 'error', 'deploy', `Not scheduled: ${problem}`)
    }
    if (!options.triggers) return
    const results = await options.triggers.syncProjectTriggers(project, deployed.config.triggers)
    for (const result of results) {
      if (result.status === 'failed') {
        event(project, 'error', 'trigger', `Trigger "${result.name}" could not be subscribed: ${result.error}`)
      } else if (result.status === 'pending') {
        event(project, 'warn', 'trigger', `Trigger "${result.name}" is subscribed once Home Assistant is connected`)
      }
    }
  }

  function outputLogger(project: string, tail: string[]) {
    const partial = { stdout: '', stderr: '' }
    return (chunk: { stream: 'stdout' | 'stderr'; text: string }) => {
      const lines = (partial[chunk.stream] + chunk.text).split('\n')
      partial[chunk.stream] = lines.pop() ?? ''
      const entries: NewLogEntry[] = lines
        .filter((line) => line.trim())
        .map((message) => ({ project, source: 'runtime', level: chunk.stream === 'stderr' ? 'error' : 'info', message }))
      for (const entry of entries) {
        tail.push(entry.message)
        if (tail.length > OUTPUT_TAIL_LINES) tail.shift()
      }
      try {
        appendLogs(host, entries)
      } catch (err) {
        console.error(`Could not record runtime output for ${project}`, err)
      }
    }
  }

  // Lines for an invocation of another project go to the project log without
  // one. Each invocation keeps at most MAX_LINES_PER_INVOCATION lines.
  function invocationLines(project: string, inst: Instance | undefined) {
    const owned = host.db.prepare(
      'SELECT 1 FROM invocations i JOIN projects p ON p.id = i.project_id WHERE i.id = ? AND p.name = ?',
    )
    const known = new Map<number, boolean>()
    const entries: NewLogEntry[] = []
    return {
      entries,
      add(entry: NewLogEntry) {
        let invocationId = entry.invocationId
        if (invocationId !== undefined) {
          if (!known.has(invocationId)) known.set(invocationId, owned.get(invocationId, project) !== undefined)
          if (!known.get(invocationId)) invocationId = undefined
        }
        if (invocationId !== undefined && inst) {
          const count = (inst.lines.get(invocationId) ?? 0) + 1
          inst.lines.set(invocationId, count)
          if (count > MAX_LINES_PER_INVOCATION + 1) return
          if (count === MAX_LINES_PER_INVOCATION + 1) {
            entries.push({
              project,
              invocationId,
              source: 'runtime',
              level: 'warn',
              message: `More than ${MAX_LINES_PER_INVOCATION} log lines; the rest of this invocation's lines were dropped`,
            })
            return
          }
        }
        entries.push({ ...entry, invocationId })
      },
    }
  }

  async function handleInternal(project: string, instance: () => Instance | undefined, request: Request): Promise<Response> {
    const url = new URL(request.url)
    const route = `${request.method} ${url.pathname}`
    if (!INTERNAL_ROUTES.has(route)) {
      return Response.json({ error: `${route} does not exist` }, { status: 404 })
    }
    const body = await request.text()
    if (body.length > MAX_INTERNAL_BODY_BYTES) return Response.json({ error: 'Request body too large' }, { status: 413 })
    if (route === 'POST /v1/db') {
      const data = options.data
      if (!data) return Response.json({ error: 'This Hobwork host has no project DBs' }, { status: 503 })
      return dbResponse(body, (request) => data.execute({ project }, request))
    }
    if (route === 'POST /v1/ha') {
      return haResponse(body, {
        ha: options.homeAssistant,
        access: 'full',
        log: ({ invocation, level, message }) => {
          const lines = invocationLines(project, instance())
          lines.add({ project, invocationId: invocation, source: 'runtime', level, message })
          appendLogs(host, lines.entries)
        },
      })
    }
    let batch: LogBatch
    try {
      batch = JSON.parse(body) as LogBatch
    } catch {
      return Response.json({ error: 'Body must be JSON' }, { status: 400 })
    }
    const lines = invocationLines(project, instance())
    for (const line of batch.lines ?? []) {
      lines.add({
        project,
        invocationId: typeof line.invocation === 'number' ? line.invocation : undefined,
        source: 'handler',
        level: ['debug', 'info', 'warn', 'error'].includes(line.level) ? line.level : 'info',
        message: String(line.message),
        time: typeof line.time === 'string' && !Number.isNaN(Date.parse(line.time)) ? new Date(line.time).toISOString() : undefined,
      })
    }
    appendLogs(host, lines.entries)
    return new Response(null, { status: 204 })
  }

  async function waitReady(url: string, exited: Promise<unknown>, tail: string[]): Promise<void> {
    let done = false
    const exit = exited.then(() => {
      done = true
    })
    const deadline = Date.now() + readyTimeoutMs
    while (!done) {
      if (Date.now() > deadline) throw new Error(`Runner was not ready after ${readyTimeoutMs / 1000}s`)
      try {
        const res = await Promise.race([fetch(`${url}/ready`, { signal: AbortSignal.timeout(2000) }), exit])
        if (res instanceof Response && res.ok) return
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`Runner exited during start${tail.length ? `:\n${tail.join('\n')}` : ''}`)
  }

  function secretsFingerprint(project: string): string {
    return options.secrets?.fingerprint(project) ?? ''
  }

  async function startInstance(project: string, deployed: Deployed, fingerprint: string): Promise<Instance> {
    const createSandbox = options.createSandbox
    if (!createSandbox || !options.image) {
      throw new RuntimeUnavailable('This Hobwork host cannot run handlers: no runtime VM backend is configured')
    }
    const build = await builder.ensure(project, deployed.commit)
    const secrets = options.secrets?.forSandbox(project) ?? {}
    const egress = [...new Set([...deployed.config.egress, ...(options.secrets?.hosts(project) ?? [])])]
    let inst: Instance | undefined
    const sandbox = await createSandbox({
      image: options.image,
      memory: options.memory ?? '512M',
      cpus: 2,
      mounts: {
        [APP_DIR]: { hostPath: build, readonly: true },
        [RUNNER_DIR]: { hostPath: HOST_RUNNER_DIR, readonly: true },
      },
      env: { NODE_ENV: 'production' },
      egress,
      secrets,
      internal: (request) => handleInternal(project, () => inst, request),
      onEgressBlocked: ({ hostname, ip, port }) =>
        event(
          project,
          'warn',
          'egress-blocked',
          `Blocked outgoing request to ${hostname || ip}:${port}. Add the host to "egress" in hobwork.json to allow it, or assign a secret that may be sent to it`,
        ),
      label: `runtime ${project} v${deployed.version}`,
    })
    const tail: string[] = []
    try {
      const proc = sandbox.exec(`node ${RUNNER_DIR}/main.ts`, {
        env: {
          HOBWORK_APP_DIR: APP_DIR,
          HOBWORK_RUNNER_PORT: String(RUNNER_PORT),
          HOBWORK_HANDLERS: JSON.stringify(allHandlers(deployed.config)),
          HOBWORK_SECRETS: JSON.stringify(Object.keys(secrets)),
        },
        onOutput: outputLogger(project, tail),
      })
      const url = await sandbox.ingress(RUNNER_PORT)
      await waitReady(url, proc.result, tail)
      inst = {
        deployed,
        secretsFingerprint: fingerprint,
        sandbox,
        url,
        inflight: new Set(),
        lines: new Map(),
        stopping: false,
        onIdle: [],
      }
      const started = inst
      void proc.result.then(
        (result) => {
          if (started.stopping) return
          const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`
          event(project, 'error', 'crash', `Runtime of version ${deployed.version} crashed: runner ended with ${reason}`)
          void retire(project, started, 'crashed')
        },
        () => {},
      )
      return inst
    } catch (err) {
      await sandbox.stop().catch(() => {})
      throw err
    }
  }

  function ensureInstance(project: string, deployed: Deployed): Promise<Instance> {
    const s = state(project)
    const fingerprint = secretsFingerprint(project)
    const current = s.instance
    if (current && current.deployed === deployed && current.secretsFingerprint === fingerprint && !current.stopping) {
      return Promise.resolve(current)
    }
    if (s.starting?.deployed === deployed && s.starting.secretsFingerprint === fingerprint) return s.starting.promise
    const promise = (async () => {
      const started = performance.now()
      const inst = await startInstance(project, deployed, fingerprint)
      if (s.deployed !== deployed) {
        await retire(project, inst, 'a newer version was deployed while it started')
        throw new Error('A newer version was deployed while the runtime started. Try again')
      }
      const old = s.instance
      s.instance = inst
      event(project, 'info', 'start', `Runtime of version ${deployed.version} started in ${Math.round(performance.now() - started)}ms`)
      if (old) {
        const reason = old.deployed === deployed ? 'secrets changed' : `replaced by version ${deployed.version}`
        void retire(project, old, reason)
      }
      armIdle(project, inst)
      return inst
    })()
    s.starting = { deployed, secretsFingerprint: fingerprint, promise }
    void promise
      .finally(() => {
        if (s.starting?.promise === promise) s.starting = undefined
      })
      .catch(() => {})
    return promise
  }

  // Waits for running invocations (up to the invocation timeout), then stops the VM.
  async function retire(project: string, inst: Instance, reason: string) {
    if (inst.stopping) return
    inst.stopping = true
    clearTimeout(inst.idleTimer)
    const s = state(project)
    if (s.instance === inst) s.instance = undefined
    if (inst.inflight.size) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, invocationTimeoutMs)
        inst.onIdle.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    await inst.sandbox.stop().catch((err: unknown) => console.error(`Stopping the runtime VM of ${project} failed`, err))
    event(project, 'info', 'stop', `Runtime of version ${inst.deployed.version} stopped: ${reason}`)
  }

  function armIdle(project: string, inst: Instance) {
    clearTimeout(inst.idleTimer)
    if (inst.stopping || inst.inflight.size) return
    const timeout = inst.deployed.config.idleTimeoutMs
    inst.idleTimer = setTimeout(() => {
      if (!inst.inflight.size) void retire(project, inst, `idle for ${Math.round(timeout / 1000)}s`)
    }, timeout)
    inst.idleTimer.unref()
  }

  function scheduleAutoRevert(project: string, deployed: Deployed, reason: string): number | undefined {
    // Restores are never reverted, so a broken restore cannot start a loop.
    if (deployed.reason !== 'merge' || deployed.reverting || !options.revert || deployed.version === null) return undefined
    const target = deployed.version - 1
    if (target < 1) return undefined
    deployed.reverting = true
    event(project, 'error', 'auto-revert', `Version ${deployed.version} is broken: ${reason}. Restoring version ${target} automatically`)
    const revert = options.revert
    // Deploy runs inside delivery's per-project queue, which the restore joins,
    // so it must not be awaited here.
    setImmediate(() => {
      if (state(project).deployed !== deployed) return
      revert({
        project,
        version: target,
        summary: `Auto-revert to version ${target}: version ${deployed.version} ${reason}`,
      }).catch((err: unknown) =>
        event(project, 'error', 'auto-revert', `Restoring version ${target} failed: ${errorMessage(err)}`),
      )
    })
    return target
  }

  async function callRunner(inst: Instance, message: InvokeRequest): Promise<InvokeResult> {
    let res: Response
    try {
      res = await fetch(`${inst.url}/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(invocationTimeoutMs),
      })
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        return {
          ok: false,
          error: { name: 'TimeoutError', message: `Timed out after ${invocationTimeoutMs / 1000}s. The handler may still be running` },
        }
      }
      throw err
    }
    return (await res.json()) as InvokeResult
  }

  async function run(project: string, deployed: Deployed, input: InvokeInput, handler: string): Promise<InvokeOutcome> {
    const invocationId = startInvocation(host, {
      project,
      version: deployed.version,
      kind: input.kind,
      name: input.name,
      manual: input.manual,
    })
    const started = performance.now()
    let inst: Instance | undefined
    let result: InvokeResult
    try {
      inst = await ensureInstance(project, deployed)
      inst.inflight.add(invocationId)
      clearTimeout(inst.idleTimer)
      result = await callRunner(inst, {
        invocation: { id: invocationId, kind: input.kind, name: input.name, manual: input.manual },
        handler,
        request: input.request,
        params: input.params,
        payload: input.payload,
      })
    } catch (err) {
      const unavailable = err instanceof RuntimeUnavailable
      result = {
        ok: false,
        error: {
          name: unavailable ? 'RuntimeUnavailable' : 'RuntimeError',
          message: unavailable ? errorMessage(err) : `The runtime failed: ${errorMessage(err)}`,
        },
      }
    } finally {
      if (inst) {
        inst.inflight.delete(invocationId)
        inst.lines.delete(invocationId)
        if (!inst.inflight.size) inst.onIdle.splice(0).forEach((resolve) => resolve())
        armIdle(project, inst)
      }
    }
    const durationMs = performance.now() - started
    const httpStatus = result.ok && (input.kind === 'route' || input.kind === 'webhook') ? result.response.status : undefined
    finishInvocation(host, invocationId, {
      status: result.ok ? 'ok' : 'error',
      durationMs,
      httpStatus,
      ...(result.ok ? {} : { error: `${result.error.name}: ${result.error.message}`, stack: result.error.stack }),
    })
    if (!result.ok) {
      appendLog(host, {
        project,
        invocationId,
        source: 'runtime',
        level: 'error',
        message: `${input.kind} "${input.name}" failed: ${result.error.stack ?? `${result.error.name}: ${result.error.message}`}`,
      })
    }
    // A host without a runtime backend says nothing about the version.
    const counts = result.ok || result.error.name !== 'RuntimeUnavailable'
    const revertReason = counts ? deployed.health?.record(result.ok, Date.now()) : undefined
    if (revertReason) scheduleAutoRevert(project, deployed, revertReason)
    return { invocationId, version: deployed.version, durationMs: Math.round(durationMs), ...result }
  }

  async function invoke(project: string, input: InvokeInput): Promise<InvokeOutcome> {
    const deployed = await deployment(project)
    const entry = entriesOf(deployed.config, input.kind)[input.name]
    if (!entry) {
      const names = Object.keys(entriesOf(deployed.config, input.kind))
      throw new ProjectError(
        `${project} version ${deployed.version} has no ${input.kind} "${input.name}". ${
          names.length ? `Its ${input.kind}s: ${names.join(', ')}` : `It has no ${input.kind}s`
        }`,
      )
    }
    return run(project, deployed, input, entry.handler)
  }

  async function deploy(deployment: Deployment): Promise<void> {
    const { project, version, commit, reason } = deployment
    event(project, 'info', 'deploy', `Deploying version ${version} (${reason})`)
    const config = await readProjectConfig(host, project, commit)
    try {
      await builder.ensure(project, commit)
    } catch (err) {
      event(project, 'error', 'deploy', `Version ${version} has no build: ${errorMessage(err)}`)
      throw err
    }
    const deployed: Deployed = {
      version,
      commit,
      config,
      routes: parseRoutes(config.routes),
      reason,
      health: createDeployHealth(policy, Date.now()),
    }
    const s = state(project)
    try {
      await options.data?.migrate(project, commit)
    } catch (err) {
      // The dry run passed, so the production data changed since. The version
      // cannot run without its schema.
      s.deployed = deployed
      const message = `Version ${version} did not start: ${errorMessage(err)}`
      event(project, 'error', 'migration', message)
      const target = scheduleAutoRevert(project, deployed, 'could not migrate the project DB')
      throw new Error(target ? `${message}\nRestoring version ${target} automatically.` : message)
    }
    s.deployed = deployed
    await applyEntryPoints(project, deployed)
    if (!options.createSandbox) return
    try {
      await ensureInstance(project, deployed)
    } catch (err) {
      const message = `Version ${version} did not start: ${errorMessage(err)}`
      event(project, 'error', 'crash', message)
      const target = scheduleAutoRevert(project, deployed, `did not start`)
      throw new Error(target ? `${message}\nRestoring version ${target} automatically.` : message)
    }
    event(project, 'info', 'deploy', `Version ${version} is live`)
  }

  // Registers the crons and triggers of the project's current version.
  async function load(project: string): Promise<void> {
    await applyEntryPoints(project, await deployment(project))
  }

  return {
    deploy,
    invoke,
    load,
    async route(project: string): Promise<{ routes: Route[]; version: number | null }> {
      const deployed = await deployment(project)
      return { routes: deployed.routes, version: deployed.version }
    },
    // What the deployed version declares in hobwork.json.
    async config(project: string): Promise<{ config: ProjectConfig; version: number | null }> {
      const deployed = await deployment(project)
      return { config: deployed.config, version: deployed.version }
    },
    // The deployed version's build, built first when it has none yet.
    async build(project: string): Promise<string> {
      return builder.ensure(project, (await deployment(project)).commit)
    },
    // The deployed version's build if it is stored, without building it.
    async storedBuild(project: string): Promise<string | undefined> {
      const { commit } = await deployment(project)
      const dir = buildDir(host, project, await treeOf(repoPath(host, project), commit))
      return existsSync(dir) ? dir : undefined
    },
    async webhookExists(project: string, name: string): Promise<boolean> {
      return name in (await deployment(project)).config.webhooks
    },
    crons(project: string): ScheduledCron[] {
      return scheduler.list(project)
    },
    status(project: string): { version: number | null; running: boolean } {
      const s = projects.get(project)
      return { version: s?.deployed?.version ?? null, running: Boolean(s?.instance && !s.instance.stopping) }
    },
    get canRun(): boolean {
      return Boolean(options.createSandbox && options.image)
    },
    async start(): Promise<void> {
      failInterruptedInvocations(host)
      pruneLogs(host)
      pruneTimer = setInterval(() => pruneLogs(host), PRUNE_INTERVAL_MS)
      pruneTimer.unref()
      for (const { name } of listProjects(host)) {
        await load(name).catch((err: unknown) => console.error(`Loading the entry points of ${name} failed`, err))
      }
    },
    async stop(): Promise<void> {
      clearInterval(pruneTimer)
      scheduler.stop()
      await Promise.all(
        [...projects].flatMap(([project, s]) => (s.instance ? [retire(project, s.instance, 'host shutting down')] : [])),
      )
    },
  }
}

export type Runtime = ReturnType<typeof createRuntime>
