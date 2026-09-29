import { HttpError, json, readJson } from '../http.ts'
import { deleteProject, TRASH_DAYS, type ProjectDeletionDeps } from '../project-deletion.ts'
import { getProject } from '../projects.ts'
import type { ApiRoute } from './router.ts'

// Only people delete projects. Agents have no tool for it, so a misled agent
// cannot destroy a project and its data.
export function projectDeletionRoutes(deps: ProjectDeletionDeps): ApiRoute[] {
  return [
    {
      method: 'DELETE',
      pattern: /^\/api\/projects\/([^/]+)$/,
      handle: async ({ req, res, user, params }) => {
        const name = params[0]!
        if (!getProject(deps.host, name)) throw new HttpError(404, `There is no hob called "${name}"`)
        const body = (await readJson(req)) as { confirm?: unknown } | null
        if (body?.confirm !== name) throw new HttpError(400, `Type the hob name, ${name}, to delete it`)
        const { purgeAfter } = await deleteProject(deps, name, { user })
        json(res, 200, { deleted: name, recoverableUntil: purgeAfter, trashDays: TRASH_DAYS })
      },
    },
  ]
}
