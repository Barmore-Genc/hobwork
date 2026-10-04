import {
  AiSettingsError,
  checkModels,
  DEFAULT_LIMITS,
  DEFAULT_MODELS,
  hostAiSettings,
  hostModels,
  parseLimits,
  parseModelOverrides,
  projectAiSettings,
  saveHostAiSettings,
  saveProjectAiSettings,
  applyOverrides,
  type AiConfig,
} from '../ai/settings.ts'
import { projectUsage, usageByProject } from '../ai/usage.ts'
import type { Host } from '../host.ts'
import { HttpError, json, readJson } from '../http.ts'
import { getProject } from '../projects.ts'
import { SecretError, type SecretStore } from '../secrets.ts'
import type { ApiRoute } from './router.ts'

const HOST_PATH = /^\/api\/settings\/ai$/
// The env name the SDK's OpenRouter helper reads the key from.
const OPENROUTER_SECRET = 'OPENROUTER_API_KEY'
const KEY_PATH = /^\/api\/settings\/ai\/key$/
const PROJECT_PATH = /^\/api\/projects\/([^/]+)\/ai$/

async function readBody(req: Parameters<ApiRoute['handle']>[0]['req']): Promise<Record<string, unknown>> {
  const body = (await readJson(req)) as unknown
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object')
  return body as Record<string, unknown>
}

async function settingsCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AiSettingsError) throw new HttpError(400, err.message)
    throw err
  }
}

// For users. Agents see the settings in get_hob and change only the models, over MCP.
export function aiSettingsRoutes(options: { host: Host; ai?: AiConfig; secrets?: SecretStore; now?: () => number }): ApiRoute[] {
  const { host, secrets } = options
  const ai = options.ai ?? { models: DEFAULT_MODELS }
  const now = options.now ?? Date.now

  function projectId(name: string): number {
    const project = getProject(host, name)
    if (!project) throw new HttpError(404, `There is no hob called "${name}"`)
    return project.id
  }

  function apiKey() {
    if (!secrets) return null
    const secret = secrets.forAllHobs(OPENROUTER_SECRET)
    return {
      secret: secret ? { id: secret.id, name: secret.name, updatedAt: secret.updatedAt, updatedBy: secret.updatedBy } : null,
      ownKey: secrets.projectsWithOwn(OPENROUTER_SECRET),
    }
  }

  function secretStore(): SecretStore {
    if (!secrets) throw new HttpError(503, 'This Hobwork server has no secret store')
    return secrets
  }

  function hostView() {
    return {
      ...hostAiSettings(host.db),
      apiKey: apiKey(),
      models: hostModels(host.db, ai.models),
      defaults: { models: ai.models, limits: DEFAULT_LIMITS },
      usage: usageByProject(host.db, now()),
    }
  }

  function projectView(id: number) {
    const hostSettings = hostAiSettings(host.db)
    const hostChoice = applyOverrides(ai.models, hostSettings)
    const project = projectAiSettings(host.db, id)
    return {
      host: { models: hostChoice, limits: hostSettings.limits },
      project,
      models: applyOverrides(hostChoice, project),
      limits: project.limits ?? hostSettings.limits,
      usage: projectUsage(host.db, id, now()),
    }
  }

  return [
    { method: 'GET', pattern: HOST_PATH, handle: ({ res }) => json(res, 200, hostView()) },
    {
      method: 'PUT',
      pattern: HOST_PATH,
      handle: async ({ req, res, user }) => {
        const body = await readBody(req)
        const settings = await settingsCall(async () => {
          const models = parseModelOverrides(body)
          await checkModels(ai, models)
          return { ...models, limits: parseLimits(body.limits) }
        })
        saveHostAiSettings(host.db, settings, { userId: user.id })
        json(res, 200, hostView())
      },
    },
    {
      method: 'PUT',
      pattern: KEY_PATH,
      handle: async ({ req, res, user }) => {
        const { value } = await readBody(req)
        if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Paste the OpenRouter API key')
        try {
          secretStore().setForAllHobs(
            OPENROUTER_SECRET,
            { name: 'OpenRouter API key', value: value.trim(), hosts: ['openrouter.ai'] },
            { kind: 'user', id: user.id, name: user.name },
          )
        } catch (err) {
          if (err instanceof SecretError) throw new HttpError(400, err.message)
          throw err
        }
        json(res, 200, hostView())
      },
    },
    {
      method: 'DELETE',
      pattern: KEY_PATH,
      handle: ({ res, user }) => {
        secretStore().removeForAllHobs(OPENROUTER_SECRET, { kind: 'user', id: user.id, name: user.name })
        json(res, 200, hostView())
      },
    },
    { method: 'GET', pattern: PROJECT_PATH, handle: ({ res, params }) => json(res, 200, projectView(projectId(params[0]!))) },
    {
      method: 'PUT',
      pattern: PROJECT_PATH,
      handle: async ({ req, res, user, params }) => {
        const id = projectId(params[0]!)
        const body = await readBody(req)
        const settings = await settingsCall(async () => {
          const models = parseModelOverrides(body)
          await checkModels(ai, models)
          return { ...models, limits: body.limits === null || body.limits === undefined ? null : parseLimits(body.limits) }
        })
        saveProjectAiSettings(host.db, id, settings, { userId: user.id })
        json(res, 200, projectView(id))
      },
    },
  ]
}
