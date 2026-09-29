import type { AiGateway } from '../ai/gateway.ts'
import type { Devices } from '../devices/devices.ts'
import { devicesResponse } from '../devices/internal.ts'
import { ENVIRONMENT_PATHS, type WorkspaceEnvironment } from '../guest-vm.ts'
import type { HomeAssistant } from '../homeassistant/client.ts'
import { haResponse } from '../homeassistant/internal.ts'
import type { Host } from '../host.ts'
import { appendLog } from '../runtime/logs.ts'
import type { SecretStore } from '../secrets.ts'
import { dbResponse } from './internal.ts'
import type { ProjectData } from './project-data.ts'

const MAX_INTERNAL_BODY_BYTES = 5 * 1024 * 1024

// Workspace VMs get the project's secrets (as placeholders) and their hosts,
// a DB copied from production when the VM starts, reachable at
// http://hobwork.internal/v1/db like in the runtime, and read-only Home
// Assistant access at /v1/ha, and the device list at /v1/devices.
export function createWorkspaceEnvironment(
  host: Host,
  options: { data?: ProjectData; secrets?: SecretStore; homeAssistant?: HomeAssistant; devices?: Devices; ai?: AiGateway },
): WorkspaceEnvironment {
  const { data, secrets, homeAssistant, devices, ai } = options
  return {
    async start(workspace) {
      const { project, branch } = workspace
      await data?.resetBranch(project, branch)
      return {
        egress: secrets?.hosts(project) ?? [],
        secrets: secrets?.forSandbox(project) ?? {},
        intercept: ai?.interceptor(project, { source: 'workspace', branch }),
        internal: async (request) => {
          const url = new URL(request.url)
          if (request.method !== 'POST' || !ENVIRONMENT_PATHS.has(url.pathname)) {
            return Response.json({ error: `${request.method} ${url.pathname} does not exist` }, { status: 404 })
          }
          const body = await request.text()
          if (body.length > MAX_INTERNAL_BODY_BYTES) return Response.json({ error: 'Request body too large' }, { status: 413 })
          if (url.pathname === '/v1/ha') return haResponse(body, { ha: homeAssistant, access: 'read' })
          if (url.pathname === '/v1/devices') return devicesResponse(body, { devices, project, access: 'read' })
          if (!data) return Response.json({ error: 'This Hobwork host has no hob DBs' }, { status: 503 })
          return dbResponse(body, (dbRequest) => data.executeOnBranch(project, branch, workspace.dir, dbRequest))
        },
        onEgressBlocked: ({ hostname, ip, port }) => {
          try {
            appendLog(host, {
              project,
              source: 'runtime',
              level: 'warn',
              event: 'egress-blocked',
              message: `Workspace ${branch}: blocked outgoing request to ${hostname || ip}:${port}. Add the host to "egress" in hobwork.json to allow it, or assign a secret that may be sent to it`,
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
