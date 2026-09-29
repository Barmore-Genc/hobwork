import type { WorkspaceEnvironment } from '../guest-vm.ts'
import type { Host } from '../host.ts'
import { appendLog } from '../runtime/logs.ts'
import type { SecretStore } from '../secrets.ts'
import { dbResponse } from './internal.ts'
import type { ProjectData } from './project-data.ts'

const MAX_INTERNAL_BODY_BYTES = 5 * 1024 * 1024

// Workspace VMs get the project's secrets (as placeholders) and their hosts,
// and a DB copied from production when the VM starts, reachable at
// http://hobwork.internal/v1/db like in the runtime.
export function createWorkspaceEnvironment(
  host: Host,
  options: { data?: ProjectData; secrets?: SecretStore },
): WorkspaceEnvironment {
  const { data, secrets } = options
  return {
    async start(workspace) {
      const { project, branch } = workspace
      await data?.resetBranch(project, branch)
      return {
        egress: secrets?.hosts(project) ?? [],
        secrets: secrets?.forSandbox(project) ?? {},
        internal: async (request) => {
          const url = new URL(request.url)
          if (request.method !== 'POST' || url.pathname !== '/v1/db') {
            return Response.json({ error: `${request.method} ${url.pathname} does not exist` }, { status: 404 })
          }
          if (!data) return Response.json({ error: 'This Hobwork host has no project DBs' }, { status: 503 })
          const body = await request.text()
          if (body.length > MAX_INTERNAL_BODY_BYTES) return Response.json({ error: 'Request body too large' }, { status: 413 })
          return dbResponse(body, (dbRequest) => data.executeOnBranch(project, branch, workspace.dir, dbRequest))
        },
        onEgressBlocked: ({ hostname, ip, port }) => {
          try {
            appendLog(host, {
              project,
              source: 'runtime',
              level: 'warn',
              event: 'egress-blocked',
              message: `Workspace ${branch}: blocked outgoing request to ${hostname || ip}:${port}. Add the host to "egress" in hobwork.json to allow it, or bind a secret to it`,
            })
          } catch (err) {
            console.error(`Could not record blocked egress for ${project}`, err)
          }
        },
      }
    },
    fingerprint: (workspace) => secrets?.fingerprint(workspace.project) ?? '',
    async stop(workspace) {
      await data?.closeBranch(workspace.project, workspace.branch)
    },
  }
}
