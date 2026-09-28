import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import { HomeAssistantError, type HaContext, type HomeAssistant, type TriggerVariables } from '../homeassistant/client.ts'
import { truncateMiddle } from './output.ts'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500
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

export function registerHomeAssistantTools(server: McpServer, ha: HomeAssistant): void {
  function connected(): HomeAssistant {
    if (!ha.configured) {
      throw new HomeAssistantError(
        'not_configured',
        'Home Assistant is not configured on this Hobwork host (HOBWORK_HA_URL and HOBWORK_HA_TOKEN are not set)',
      )
    }
    return ha
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
