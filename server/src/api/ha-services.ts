import { getHaServices, HaServicesError, setHaServices } from '../homeassistant/services.ts'
import type { Host } from '../host.ts'
import { HttpError, json, readJson } from '../http.ts'
import { getProject } from '../projects.ts'
import type { ApiRoute } from './router.ts'

const PATH = /^\/api\/projects\/([^/]+)\/home-assistant-services$/

export function haServicesRoutes(options: { host: Host }): ApiRoute[] {
  const { host } = options

  function project(name: string) {
    const found = getProject(host, name)
    if (!found) throw new HttpError(404, `There is no hob called "${name}"`)
    return found
  }

  return [
    {
      method: 'GET',
      pattern: PATH,
      handle: ({ res, params }) => json(res, 200, { services: getHaServices(host.db, project(params[0]!).id) }),
    },
    {
      method: 'PUT',
      pattern: PATH,
      handle: async ({ req, res, user, params }) => {
        const found = project(params[0]!)
        const body = (await readJson(req)) as unknown
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object')
        try {
          const services = setHaServices(host, found.name, (body as { services?: unknown }).services, { kind: 'user', name: user.name })
          json(res, 200, { services })
        } catch (err) {
          if (err instanceof HaServicesError) throw new HttpError(400, err.message)
          throw err
        }
      },
    },
  ]
}
