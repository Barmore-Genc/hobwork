import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { allowsProject, type Access } from '../access.ts'
import { ProjectError } from '../projects.ts'

// Tools that act across projects rather than on one, so they need access to all of them.
const EVERY_PROJECT_TOOLS = new Set(['create_project'])

type ToolConfig = { inputSchema?: object; annotations?: { readOnlyHint?: boolean } }
type Register = (name: string, config: ToolConfig, cb: (...args: unknown[]) => unknown) => RegisteredTool

// Applies a credential's access to every tool registered after this call: tools
// it may not use are left out of the tool list, and a tool's `project` argument
// must be one of its projects. Read-only access keeps the tools marked
// readOnlyHint, so every new tool is refused to it unless marked.
export function limitTools(server: McpServer, access: Access) {
  const register = server.registerTool.bind(server) as unknown as Register
  const limited: Register = (name, config, cb) => {
    const takesProject = config.inputSchema !== undefined && 'project' in config.inputSchema
    const handler = takesProject
      ? (args: unknown, ...rest: unknown[]) => {
          const project = (args as { project?: unknown }).project
          if (typeof project === 'string' && !allowsProject(access, project)) {
            throw new ProjectError(`This connection has no access to the project "${project}"`)
          }
          return cb(args, ...rest)
        }
      : cb
    const tool = register(name, config, handler)
    const readOnly = config.annotations?.readOnlyHint === true
    if ((access.readOnly && !readOnly) || (access.projects !== null && EVERY_PROJECT_TOOLS.has(name))) tool.disable()
    return tool
  }
  server.registerTool = limited as unknown as McpServer['registerTool']
}
