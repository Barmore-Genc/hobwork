import type { DeviceTrigger } from '../devices/devices.ts'
import type { HaTrigger, HomeAssistant, Logger, TriggerVariables, Unsubscribe } from './client.ts'

// A `triggers` entry from hobwork.json. Entries without a `homeassistant`
// block belong to other integrations and are ignored here.
export type TriggerEntry = { homeassistant?: HaTrigger; device?: DeviceTrigger; upload?: string; [key: string]: unknown }

export type InvokeTrigger = (project: string, triggerName: string, variables: TriggerVariables) => void | Promise<void>

export type TriggerSyncResult = {
  name: string
  // pending: Home Assistant is not connected; the trigger is subscribed once it is.
  status: 'subscribed' | 'unchanged' | 'pending' | 'removed' | 'failed'
  error?: string
}

export type TriggerRegistry = {
  // Brings the project's HA subscriptions in line with its triggers, meant to
  // be called on deploy. Unchanged triggers keep their subscription.
  syncProjectTriggers(project: string, triggers: Record<string, TriggerEntry> | undefined): Promise<TriggerSyncResult[]>
  removeProject(project: string): Promise<TriggerSyncResult[]>
  active(project: string): string[]
}

type Active = { key: string; unsubscribe: Unsubscribe }

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

export function createTriggerRegistry(options: {
  ha: HomeAssistant
  invoke: InvokeTrigger
  logger?: Logger
}): TriggerRegistry {
  const { ha, invoke } = options
  const logger = options.logger ?? console
  const projects = new Map<string, Map<string, Active>>()
  // Deploys of one project can overlap; syncing them in order keeps the
  // subscriptions matching the last deploy.
  const queues = new Map<string, Promise<unknown>>()

  function fire(project: string, name: string, variables: TriggerVariables) {
    const report = (err: unknown) => logger.error(`Invoking trigger "${name}" of hob "${project}" failed`, err)
    try {
      const result = invoke(project, name, variables)
      if (result instanceof Promise) result.catch(report)
    } catch (err) {
      report(err)
    }
  }

  async function sync(project: string, triggers: Record<string, TriggerEntry>): Promise<TriggerSyncResult[]> {
    const current = projects.get(project) ?? new Map<string, Active>()
    projects.set(project, current)
    const wanted = new Map<string, { trigger: HaTrigger; key: string }>()
    for (const [name, entry] of Object.entries(triggers)) {
      if (entry.homeassistant) wanted.set(name, { trigger: entry.homeassistant, key: canonical(entry.homeassistant) })
    }

    const results: TriggerSyncResult[] = []
    for (const [name, active] of current) {
      if (wanted.get(name)?.key === active.key) continue
      current.delete(name)
      await active.unsubscribe()
      if (!wanted.has(name)) results.push({ name, status: 'removed' })
    }
    for (const [name, { trigger, key }] of wanted) {
      if (current.has(name)) {
        results.push({ name, status: 'unchanged' })
        continue
      }
      try {
        const unsubscribe = await ha.subscribeTrigger(trigger, (variables) => fire(project, name, variables), {
          onError: (err) =>
            logger.error(`Home Assistant refused trigger "${name}" of hob "${project}": ${err.message}`),
        })
        current.set(name, { key, unsubscribe })
        results.push({ name, status: ha.status === 'connected' ? 'subscribed' : 'pending' })
      } catch (err) {
        results.push({ name, status: 'failed', error: (err as Error).message })
      }
    }
    if (current.size === 0) projects.delete(project)
    return results
  }

  function enqueue(project: string, triggers: Record<string, TriggerEntry>): Promise<TriggerSyncResult[]> {
    const run = (queues.get(project) ?? Promise.resolve()).catch(() => {}).then(() => sync(project, triggers))
    queues.set(project, run)
    void run.finally(() => {
      if (queues.get(project) === run) queues.delete(project)
    }).catch(() => {})
    return run
  }

  return {
    syncProjectTriggers: (project, triggers) => enqueue(project, triggers ?? {}),
    removeProject: (project) => enqueue(project, {}),
    active: (project) => [...(projects.get(project)?.keys() ?? [])],
  }
}
