import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { HomeAssistantError, type HaContext, type HomeAssistant, type TriggerVariables } from '../homeassistant/client.ts'
import { truncateMiddle } from './output.ts'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500
const HOUR_MS = 3_600_000
const DEFAULT_WINDOW_HOURS = 24
const DEFAULT_STATISTICS_DAYS = 7
const DEFAULT_CHANGES = 100
const MAX_CHANGES = 1000
const DEFAULT_LISTEN_SECONDS = 60
const MAX_LISTEN_SECONDS = 300
const PROGRESS_INTERVAL_MS = 10_000

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function json(value: unknown): CallToolResult {
  return text(truncateMiddle(JSON.stringify(value, null, 2)))
}

function matches(query: string | undefined, ...fields: (string | null | undefined)[]): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return fields.some((f) => f?.toLowerCase().includes(q))
}

function page<T>(items: T[], offset: number, limit: number) {
  const shown = items.slice(offset, offset + limit)
  const next = offset + shown.length
  return {
    total: items.length,
    offset,
    ...(next < items.length ? { next_offset: next } : {}),
    items: shown,
  }
}

const search = z.string().optional()
const limit = z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe('Maximum number of results')
const offset = z.number().int().min(0).default(0).describe('Number of results to skip, for paging')
const triggerObject = z.record(z.string(), z.unknown())
const scriptEntity = z.string().describe('Entity ID of an automation or script, e.g. "automation.coffee_came_back"')
const start = z.iso.datetime({ offset: true }).optional()
const end = z.iso.datetime({ offset: true }).optional().describe('End of the period (ISO 8601). Default: now')

function period(from: string | undefined, to: string | undefined, defaultHours: number) {
  return {
    start_time: from ?? new Date(Date.now() - defaultHours * HOUR_MS).toISOString(),
    ...(to ? { end_time: to } : {}),
  }
}

function fromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

function scriptDomain(entityId: string): 'automation' | 'script' {
  const domain = entityId.split('.')[0]
  if (domain !== 'automation' && domain !== 'script') {
    throw new HomeAssistantError('invalid_input', 'Pass an automation.* or script.* entity ID')
  }
  return domain
}

export function registerHomeAssistantTools(server: McpServer, ha: HomeAssistant): void {
  function connected(): HomeAssistant {
    if (!ha.configured) {
      throw new HomeAssistantError(
        'not_configured',
        'Home Assistant is not connected to this Hobwork host. A person can connect it in Settings in the Hobwork web UI',
      )
    }
    return ha
  }

  // Traces are keyed by the automation's `id` from its config, not by entity ID.
  async function traceItem(client: HomeAssistant, entityId: string) {
    const domain = scriptDomain(entityId)
    if (domain === 'script') return { domain, itemId: entityId.slice('script.'.length) }
    const state = await client.getState(entityId)
    if (!state) {
      throw new HomeAssistantError('not_found', `Home Assistant has no automation "${entityId}". Find them with ha_list_entities and domain "automation"`)
    }
    const id = state.attributes.id
    if (typeof id !== 'string') {
      throw new HomeAssistantError('not_found', `${entityId} has no id in its config, so Home Assistant keeps no traces for it`)
    }
    return { domain, itemId: id }
  }

  async function areaNames(client: HomeAssistant): Promise<Map<string, string>> {
    return new Map((await client.listAreas()).map((a) => [a.area_id, a.name]))
  }

  server.registerTool(
    'ha_list_devices',
    {
      description:
        'List devices in Home Assistant (device registry), for finding the device_id of a button, sensor or light. Use ha_list_device_triggers with a device_id to get ready-made triggers for hobwork.json.',
      inputSchema: {
        search: search.describe('Case-insensitive text matched against name, manufacturer, model, area and id'),
        area: z.string().optional().describe('Only devices in this area (area name or area_id)'),
        integration: z.string().optional().describe('Only devices from this integration, e.g. "zha", "mqtt", "hue"'),
        include_disabled: z.boolean().default(false),
        limit,
        offset,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search: q, area, integration, include_disabled, limit: max, offset: skip }) => {
      const client = connected()
      const [devices, areas] = await Promise.all([client.listDevices(), areaNames(client)])
      const items = devices
        .filter((d) => include_disabled || !d.disabled_by)
        .map((d) => ({
          id: d.id,
          name: d.name_by_user ?? d.name,
          manufacturer: d.manufacturer,
          model: d.model,
          area: d.area_id ? (areas.get(d.area_id) ?? d.area_id) : null,
          area_id: d.area_id,
          integrations: [...new Set(d.identifiers.map(([domain]) => domain))],
          ...(d.disabled_by ? { disabled_by: d.disabled_by } : {}),
        }))
        .filter((d) => matches(q, d.name, d.manufacturer, d.model, d.area, d.id))
        .filter((d) => !area || d.area_id === area || d.area?.toLowerCase() === area.toLowerCase())
        .filter((d) => !integration || d.integrations.includes(integration))
      return json(page(items, skip, max))
    },
  )

  server.registerTool(
    'ha_list_entities',
    {
      description:
        'List Home Assistant entities with their current state, e.g. lights, switches, sensors and buttons. Use ha_get_state for the attributes of one entity.',
      inputSchema: {
        search: search.describe('Case-insensitive text matched against entity_id and name'),
        domain: z.string().optional().describe('Only entities of this domain, e.g. "light", "sensor", "input_boolean"'),
        device_id: z.string().optional().describe('Only entities belonging to this device'),
        area: z.string().optional().describe('Only entities in this area (area name or area_id), directly or through their device'),
        limit,
        offset,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search: q, domain, device_id, area, limit: max, offset: skip }) => {
      const client = connected()
      const [states, registry, devices, areas] = await Promise.all([
        client.getStates(),
        client.listEntities(),
        client.listDevices(),
        areaNames(client),
      ])
      const entries = new Map(registry.map((e) => [e.entity_id, e]))
      const deviceAreas = new Map(devices.map((d) => [d.id, d.area_id]))
      const items = states
        .map((s) => {
          const entry = entries.get(s.entity_id)
          const areaId = entry?.area_id ?? (entry?.device_id ? deviceAreas.get(entry.device_id) : null) ?? null
          const name = s.attributes.friendly_name
          return {
            entity_id: s.entity_id,
            name: typeof name === 'string' ? name : null,
            state: s.state,
            device_id: entry?.device_id ?? null,
            area: areaId ? (areas.get(areaId) ?? areaId) : null,
            area_id: areaId,
            platform: entry?.platform ?? null,
          }
        })
        .filter((e) => matches(q, e.entity_id, e.name))
        .filter((e) => !domain || e.entity_id.startsWith(`${domain}.`))
        .filter((e) => !device_id || e.device_id === device_id)
        .filter((e) => !area || e.area_id === area || e.area?.toLowerCase() === area.toLowerCase())
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
      return json(page(items, skip, max))
    },
  )

  server.registerTool(
    'ha_get_state',
    {
      description: 'Get the current state and attributes of one Home Assistant entity.',
      inputSchema: { entity_id: z.string().describe('Entity ID, e.g. "light.kitchen"') },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id }) => {
      const state = await connected().getState(entity_id)
      if (!state) {
        throw new HomeAssistantError('not_found', `Home Assistant has no entity "${entity_id}". Find entities with ha_list_entities`)
      }
      return json(state)
    },
  )

  server.registerTool(
    'ha_list_services',
    {
      description:
        'List the services (actions) Home Assistant can perform, such as light.turn_on or tts.speak. Without a service, lists names and descriptions. With domain and service, shows the full definition including fields.',
      inputSchema: {
        domain: z.string().optional().describe('Only services of this domain, e.g. "light"'),
        service: z.string().optional().describe('Service name within the domain, e.g. "turn_on". Requires domain'),
        search: search.describe('Case-insensitive text matched against service name and description'),
        limit,
        offset,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ domain, service, search: q, limit: max, offset: skip }) => {
      const services = await connected().listServices()
      if (service) {
        if (!domain) throw new HomeAssistantError('invalid_input', 'Pass domain together with service')
        const definition = services[domain]?.[service]
        if (!definition) {
          throw new HomeAssistantError('not_found', `Home Assistant has no service "${domain}.${service}"`)
        }
        return json({ service: `${domain}.${service}`, ...definition })
      }
      const items = Object.entries(services)
        .filter(([d]) => !domain || d === domain)
        .flatMap(([d, byName]) =>
          Object.entries(byName).map(([name, def]) => ({
            service: `${d}.${name}`,
            name: def.name ?? null,
            description: def.description ?? null,
            fields: Object.keys(def.fields ?? {}),
            takes_target: def.target !== undefined,
          })),
        )
        .filter((s) => matches(q, s.service, s.name, s.description))
        .sort((a, b) => a.service.localeCompare(b.service))
      return json(page(items, skip, max))
    },
  )

  server.registerTool(
    'ha_list_device_triggers',
    {
      description:
        'List the triggers a Home Assistant device offers, such as button presses. Each one can be used as-is as the "homeassistant" block of a trigger in hobwork.json, or passed to ha_listen.',
      inputSchema: { device_id: z.string().describe('Device ID from ha_list_devices') },
      annotations: { readOnlyHint: true },
    },
    async ({ device_id }) => json(await connected().listDeviceTriggers(device_id)),
  )

  server.registerTool(
    'ha_get_automation',
    {
      description:
        'Show a Home Assistant automation or script: its config (triggers, conditions and actions, as in the YAML editor), whether it is on and when it last ran. Find them with ha_list_entities and domain "automation" or "script", or with ha_find_related.',
      inputSchema: { entity_id: scriptEntity },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id }) => {
      const domain = scriptDomain(entity_id)
      const client = connected()
      const [state, config] = await Promise.all([
        client.getState(entity_id),
        client.getConfig(entity_id).catch((err: unknown) => {
          if (err instanceof HomeAssistantError && err.code === 'not_found') {
            throw new HomeAssistantError(
              'not_found',
              `Home Assistant has no ${domain} "${entity_id}". Find them with ha_list_entities and domain "${domain}"`,
            )
          }
          throw err
        }),
      ])
      const name = state?.attributes.friendly_name
      return json({
        entity_id,
        name: typeof name === 'string' ? name : null,
        state: state?.state ?? null,
        last_triggered: state?.attributes.last_triggered ?? null,
        config,
      })
    },
  )

  server.registerTool(
    'ha_find_related',
    {
      description:
        'Find what in Home Assistant is related to an item, e.g. the automations and scripts that use a device or entity, or the devices and entities an automation uses. Returns IDs grouped by type (automation, script, device, entity, area, ...).',
      inputSchema: {
        item_type: z
          .enum(['device', 'entity', 'automation', 'script', 'area', 'scene', 'group', 'label', 'floor', 'config_entry', 'integration'])
          .describe('Type of the item'),
        item_id: z.string().describe('Its ID: a device ID, entity ID (also for automations and scripts), area ID, ...'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ item_type, item_id }) => json(await connected().searchRelated(item_type, item_id)),
  )

  server.registerTool(
    'ha_list_traces',
    {
      description:
        'List the recent runs of a Home Assistant automation or script, newest first: when it ran, what triggered it, the step it stopped at and any error. Home Assistant keeps the last 5 runs unless the automation sets stored_traces. Show one run with ha_get_trace.',
      inputSchema: { entity_id: scriptEntity },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id }) => {
      const client = connected()
      const { domain, itemId } = await traceItem(client, entity_id)
      const traces = await client.listTraces(domain, itemId)
      return json(
        traces
          .map((t) => ({
            run_id: t.run_id,
            started: t.timestamp.start,
            finished: t.timestamp.finish,
            state: t.state,
            execution: t.script_execution,
            trigger: t.trigger ?? null,
            last_step: t.last_step,
            error: t.error ?? null,
          }))
          .sort((a, b) => b.started.localeCompare(a.started)),
      )
    },
  )

  server.registerTool(
    'ha_get_trace',
    {
      description:
        'Show one run of a Home Assistant automation or script step by step: the trigger variables, each condition with its result, each action with its result or error. Use it to see why an automation did not do what it should.',
      inputSchema: { entity_id: scriptEntity, run_id: z.string().describe('run_id from ha_list_traces') },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id, run_id }) => {
      const client = connected()
      const { domain, itemId } = await traceItem(client, entity_id)
      const trace = await client.getTrace(domain, itemId, run_id).catch((err: unknown) => {
        if (err instanceof HomeAssistantError && err.code === 'not_found') {
          throw new HomeAssistantError('not_found', `${entity_id} has no run "${run_id}". List runs with ha_list_traces`)
        }
        throw err
      })
      // The config is what ha_get_automation shows, and `this` in every step
      // repeats the automation's own state.
      const shown: Record<string, unknown> = { ...trace }
      delete shown.config
      delete shown.blueprint_inputs
      const steps = trace.trace as Record<string, Record<string, unknown>[]> | undefined
      if (steps) {
        shown.trace = Object.fromEntries(
          Object.entries(steps).map(([path, runs]) => [
            path,
            runs.map((run) => {
              const variables = run.changed_variables as Record<string, unknown> | undefined
              if (!variables || !('this' in variables)) return run
              const rest = { ...variables }
              delete rest.this
              return { ...run, changed_variables: rest }
            }),
          ]),
        )
      }
      return json(shown)
    },
  )

  server.registerTool(
    'ha_history',
    {
      description: `Show how Home Assistant entities changed over a period: each state with when it changed, oldest first, from the recorder. Default period: the last ${DEFAULT_WINDOW_HOURS} hours. Shows the latest \`limit\` changes per entity.`,
      inputSchema: {
        entity_ids: z.array(z.string()).min(1).max(20).describe('Entity IDs, e.g. ["binary_sensor.door"]'),
        start: start.describe(`Start of the period (ISO 8601, e.g. "2026-09-28T06:00:00+02:00"). Default: ${DEFAULT_WINDOW_HOURS} hours ago`),
        end,
        attributes: z.boolean().default(false).describe('Include attributes, and changes of attributes only'),
        limit: z.number().int().min(1).max(MAX_CHANGES).default(DEFAULT_CHANGES).describe('Maximum number of changes per entity'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_ids, start: from, end: to, attributes, limit: max }) => {
      const history = await connected().history({
        ...period(from, to, DEFAULT_WINDOW_HOURS),
        entity_ids,
        no_attributes: !attributes,
      })
      return json(
        Object.fromEntries(
          entity_ids.map((id) => {
            const changes = history[id] ?? []
            return [
              id,
              {
                total: changes.length,
                changes: changes.slice(-max).map((c) => ({
                  state: c.s,
                  last_changed: fromSeconds(c.lc ?? c.lu),
                  ...(c.lc !== undefined ? { last_updated: fromSeconds(c.lu) } : {}),
                  ...(c.a ? { attributes: c.a } : {}),
                })),
              },
            ]
          }),
        ),
      )
    },
  )

  server.registerTool(
    'ha_logbook',
    {
      description: `Show the Home Assistant logbook, newest first: state changes and events with what caused them, e.g. "triggered by state of binary_sensor.door" or the automation, script or user behind a change. Default period: the last ${DEFAULT_WINDOW_HOURS} hours. Without entity_ids or device_ids it covers everything.`,
      inputSchema: {
        start: start.describe(`Start of the period (ISO 8601). Default: ${DEFAULT_WINDOW_HOURS} hours ago`),
        end,
        entity_ids: z.array(z.string()).optional().describe('Only these entities (automations and scripts included)'),
        device_ids: z.array(z.string()).optional().describe('Only these devices'),
        context_id: z.string().optional().describe('Only entries from this context, to follow what one trigger caused'),
        limit,
        offset,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ start: from, end: to, entity_ids, device_ids, context_id, limit: max, offset: skip }) => {
      const entries = await connected().logbook({
        ...period(from, to, DEFAULT_WINDOW_HOURS),
        ...(entity_ids ? { entity_ids } : {}),
        ...(device_ids ? { device_ids } : {}),
        ...(context_id ? { context_id } : {}),
      })
      const items = entries
        .sort((a, b) => b.when - a.when)
        .map((e) => ({ ...e, when: fromSeconds(e.when) }))
      return json(page(items, skip, max))
    },
  )

  server.registerTool(
    'ha_system_log',
    {
      description:
        "Show Home Assistant's own warnings and errors, newest first, such as an integration losing a device or a service call failing. Repeated messages are counted once. Home Assistant keeps the latest 50 unless system_log sets max_entries.",
      inputSchema: {
        level: z.enum(['critical', 'error', 'warning', 'info', 'debug']).optional().describe('Only entries of this level'),
        search: search.describe('Case-insensitive text matched against the logger name and message'),
        limit,
        offset,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ level, search: q, limit: max, offset: skip }) => {
      const items = (await connected().systemLog())
        .filter((e) => !level || e.level.toLowerCase() === level)
        .map((e) => ({
          level: e.level,
          logger: e.name,
          message: e.message.join('\n'),
          source: `${e.source[0]}:${e.source[1]}`,
          count: e.count,
          first_occurred: fromSeconds(e.first_occurred),
          last_occurred: fromSeconds(e.timestamp),
          ...(e.exception ? { exception: e.exception } : {}),
        }))
        .filter((e) => matches(q, e.logger, e.message))
        .sort((a, b) => b.last_occurred.localeCompare(a.last_occurred))
      return json(page(items, skip, max))
    },
  )

  server.registerTool(
    'ha_list_statistics',
    {
      description:
        'List the long-term statistics Home Assistant keeps, such as sensor means and energy totals. Sensors with a state_class have one under their entity ID. Read them with ha_statistics.',
      inputSchema: {
        search: search.describe('Case-insensitive text matched against statistic_id and name'),
        limit,
        offset,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ search: q, limit: max, offset: skip }) => {
      const items = (await connected().listStatisticIds())
        .map((s) => ({
          statistic_id: s.statistic_id,
          name: s.name,
          unit: s.statistics_unit_of_measurement,
          source: s.source,
          has_mean: s.has_mean,
          has_sum: s.has_sum,
        }))
        .filter((s) => matches(q, s.statistic_id, s.name))
        .sort((a, b) => a.statistic_id.localeCompare(b.statistic_id))
      return json(page(items, skip, max))
    },
  )

  server.registerTool(
    'ha_statistics',
    {
      description: `Read Home Assistant long-term statistics, aggregated per period (5 minutes, hour, day, week or month), oldest first. Statistics outlive the recorder history: hourly ones are kept indefinitely, 5-minute ones for about 10 days. Default period: the last ${DEFAULT_STATISTICS_DAYS} days. mean, min and max exist for measurements, sum, state and change for totals such as energy.`,
      inputSchema: {
        statistic_ids: z.array(z.string()).min(1).max(10).describe('Statistic IDs from ha_list_statistics, e.g. ["sensor.outdoor_temperature"]'),
        start: start.describe(`Start of the period (ISO 8601). Default: ${DEFAULT_STATISTICS_DAYS} days ago`),
        end,
        period: z.enum(['5minute', 'hour', 'day', 'week', 'month']).default('hour'),
        types: z
          .array(z.enum(['mean', 'min', 'max', 'sum', 'state', 'change']))
          .min(1)
          .default(['mean', 'min', 'max', 'sum', 'state', 'change'])
          .describe('Values to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ statistic_ids, start: from, end: to, period: every, types }) => {
      const statistics = await connected().statistics({
        ...period(from, to, DEFAULT_STATISTICS_DAYS * 24),
        statistic_ids,
        period: every,
        types,
      })
      return json(
        Object.fromEntries(
          statistic_ids.map((id) => [
            id,
            (statistics[id] ?? []).map((row) => ({
              ...row,
              start: new Date(row.start).toISOString(),
              end: new Date(row.end).toISOString(),
            })),
          ]),
        ),
      )
    },
  )

  server.registerTool(
    'ha_listen',
    {
      description: `Subscribe a Home Assistant trigger temporarily and wait until it fires, then return the variables a hobwork.json trigger with the same definition passes to its handler. Use it to see the real payload before writing a handler: ask the user to press the button or cause the change, then call this. Waits up to timeout_seconds (default ${DEFAULT_LISTEN_SECONDS}, max ${MAX_LISTEN_SECONDS}).`,
      inputSchema: {
        trigger: z
          .union([triggerObject, z.array(triggerObject).min(1)])
          .describe(
            'Trigger in Home Assistant automation syntax, e.g. {"trigger": "state", "entity_id": "binary_sensor.door", "to": "on"} or a device trigger from ha_list_device_triggers. A list fires on any of its triggers',
          ),
        timeout_seconds: z.number().int().min(1).max(MAX_LISTEN_SECONDS).default(DEFAULT_LISTEN_SECONDS),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ trigger, timeout_seconds }, extra) => {
      const client = connected()
      await client.waitUntilConnected()
      let onFire!: (fired: { variables: TriggerVariables; context: HaContext | undefined }) => void
      const fired = new Promise<{ variables: TriggerVariables; context: HaContext | undefined }>((resolve) => {
        onFire = resolve
      })
      const unsubscribe = await client.subscribeTrigger(trigger, (variables, context) => onFire({ variables, context }))

      const progressToken = extra._meta?.progressToken
      const started = Date.now()
      // Progress notifications keep clients that reset their request timeout on
      // progress from giving up before the trigger fires.
      const progress =
        progressToken === undefined
          ? undefined
          : setInterval(() => {
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress: Math.round((Date.now() - started) / 1000),
                    total: timeout_seconds,
                    message: 'Waiting for the trigger to fire',
                  },
                })
                .catch(() => {})
            }, PROGRESS_INTERVAL_MS)
      let timer: NodeJS.Timeout | undefined
      let onAbort: (() => void) | undefined
      try {
        const outcome = await Promise.race([
          fired,
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeout_seconds * 1000)
          }),
          new Promise<'aborted'>((resolve) => {
            onAbort = () => resolve('aborted')
            extra.signal.addEventListener('abort', onAbort, { once: true })
          }),
        ])
        if (outcome === 'timeout') {
          return text(`The trigger did not fire within ${timeout_seconds} seconds.`)
        }
        if (outcome === 'aborted') return text('Cancelled.')
        return json({ fired: true, variables: outcome.variables, context: outcome.context })
      } finally {
        clearTimeout(timer)
        clearInterval(progress)
        if (onAbort) extra.signal.removeEventListener('abort', onAbort)
        await unsubscribe()
      }
    },
  )
}
