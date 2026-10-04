import { readFileSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import type { AuthenticatedAgent } from '../agents.ts'
import { appReturnPath, SHARE_PATH } from '../apps/http.ts'
import type { AppTarget } from '../apps/origins.ts'
import { createShareLink } from '../apps/share-links.ts'
import type { Host } from '../host.ts'
import { DEFAULT_BRANCH, ProjectError, requireProject } from '../projects.ts'
import { branchExists } from '../repo.ts'
import { appsFrameSource } from '../static.ts'

// MCP Apps (the io.modelcontextprotocol/ui extension): a tool names a ui://
// resource, and clients that support it render the tool result with it.
export const HOB_VIEW_URI = 'ui://hobwork/hob-view'
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

const HOB_VIEW_HTML = readFileSync(new URL('./hob-view.html', import.meta.url), 'utf8')

export function registerHobViewTools(
  server: McpServer,
  options: {
    host: Host
    agent: AuthenticatedAgent
    appOrigin?: (target: AppTarget) => string | undefined
    appsUrl?: string
  },
) {
  const { host, agent, appOrigin, appsUrl } = options

  server.registerResource(
    'hob-view',
    HOB_VIEW_URI,
    { title: 'Hob app', description: 'Shows the app of a hob or branch preview from show_hob', mimeType: MCP_APP_MIME_TYPE },
    () => ({
      contents: [
        {
          uri: HOB_VIEW_URI,
          mimeType: MCP_APP_MIME_TYPE,
          text: HOB_VIEW_HTML,
          // The view frames the app origin, so the client's policy must allow
          // frames from every app origin and nothing else.
          _meta: { ui: { prefersBorder: true, ...(appsUrl ? { csp: { frameDomains: [appsFrameSource(appsUrl)] } } : {}) } },
        },
      ],
    }),
  )

  server.registerTool(
    'show_hob',
    {
      title: 'Show a hob',
      description: `Show the user the app (UI) of a hob on ${DEFAULT_BRANCH}, or a branch preview, embedded in the chat, and get a link to it. Clients that cannot embed it show the link. The link opens only that hob and branch, without signing in, for 7 days; a read-only connection makes a read-only link. To look at the app yourself, open the link in a browser, or call its routes at <app origin>/api/<route path> with the token as "Authorization: Bearer <token>". A branch preview runs the branch's last commit, so commit first. A hob without index.html has no app.`,
      inputSchema: {
        hob: z.string().describe('Hob name, e.g. "filament-tracker"'),
        branch: z.string().default(DEFAULT_BRANCH).describe(`Branch to show. ${DEFAULT_BRANCH} is the deployed version`),
        path: z.string().default('/').describe('Page of the app to open, e.g. "/spools/7"'),
      },
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: HOB_VIEW_URI } },
    },
    async ({ hob: name, branch, path }) => {
      const project = requireProject(host, name)
      const onMain = branch === DEFAULT_BRANCH
      if (!onMain && !(await branchExists(host, project.name, branch))) {
        throw new ProjectError(`Branch "${branch}" does not exist in ${project.name}`)
      }
      const origin = appOrigin?.(onMain ? { project: project.name } : { project: project.name, branch })
      if (!origin) throw new ProjectError('This Hobwork host does not serve hob apps')
      const returnTo = appReturnPath(path, origin)
      if (!returnTo) throw new ProjectError('path must be a path in the app, like "/" or "/spools/7", and not under /_hobwork/')

      const { token, expiresAt } = createShareLink(host.db, agent, { projectId: project.id, branch: onMain ? null : branch })
      const url = `${origin}${SHARE_PATH}?${new URLSearchParams({ token, returnTo })}`
      const readOnly = agent.access.readOnly
      const note = [
        `Opens the app of ${project.name}${onMain ? '' : ` (branch ${branch})`} without signing in until ${expiresAt}${readOnly ? ', read-only' : ''}.`,
        `Routes: ${origin}/api/<route path> with "Authorization: Bearer ${token}".`,
      ].join(' ')
      return {
        content: [{ type: 'text', text: `${url}\n\n${note}` }],
        structuredContent: { url, hob: project.name, branch, appOrigin: origin, token, expiresAt, readOnly },
      }
    },
  )
}
