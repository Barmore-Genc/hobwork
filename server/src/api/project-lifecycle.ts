import { HttpError, json, readJson } from '../http.ts'
import { listTrash, restoreProject, TRASH_DAYS, type ProjectRestoreDeps } from '../project-deletion.ts'
import { renameProject, type ProjectRenameDeps } from '../project-rename.ts'
import { getProject, ProjectError } from '../projects.ts'
import type { ApiRoute } from './router.ts'

async function asConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ProjectError) throw new HttpError(409, err.message)
    throw err
  }
}

function nameOf(body: unknown): string | undefined {
  const name = (body as { name?: unknown } | null)?.name
  if (name === undefined) return undefined
  if (typeof name !== 'string') throw new HttpError(400, 'name must be a string')
  return name.trim()
}

// Renaming and restoring are for people only, like deleting: renaming changes
// the URLs other systems call, so agents have no tool for either.
export function projectLifecycleRoutes(deps: ProjectRenameDeps & ProjectRestoreDeps): ApiRoute[] {
  return [
    {
      method: 'POST',
      pattern: /^\/api\/projects\/([^/]+)\/rename$/,
      handle: async ({ req, res, user, params }) => {
        const from = params[0]!
        if (!getProject(deps.host, from)) throw new HttpError(404, `There is no hob called "${from}"`)
        const to = nameOf(await readJson(req))
        if (!to) throw new HttpError(400, 'Enter a new name')
        const project = await asConflict(() => renameProject(deps, from, to, { user }))
        json(res, 200, { name: project.name })
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/trash$/,
      handle: ({ res }) => json(res, 200, { trashDays: TRASH_DAYS, projects: listTrash(deps.host) }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/trash\/([^/]+)\/restore$/,
      handle: async ({ req, res, user, params }) => {
        const id = params[0]!
        if (!listTrash(deps.host).some((entry) => entry.id === id)) {
          throw new HttpError(404, `This deleted hob is no longer kept. Hobs are removed for good ${TRASH_DAYS} days after deletion`)
        }
        const name = nameOf(await readJson(req))
        const project = await asConflict(() => restoreProject(deps, id, { name: name || undefined, user }))
        json(res, 200, { name: project.name })
      },
    },
  ]
}
