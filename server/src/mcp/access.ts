import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { allowsProject, type Access } from '../access.ts'
import { ProjectError } from '../projects.ts'

// Tools that act across hobs rather than on one, so they need access to all of them.
const EVERY_PROJECT_TOOLS = new Set(['create_hob'])

// Home Assistant tools read the whole house, not the hobs a credential may use.
const HOUSE_TOOL_PREFIX = 'ha_'

type ToolConfig = { inputSchema?: object; annotations?: { readOnlyHint?: boolean } }
type Register = (name: string, config: ToolConfig, cb: (...args: unknown[]) => unknown) => RegisteredTool

// Applies a credential's access to every tool registered after this call: tools
// it may not use are left out of the tool list, and a tool's `hob` argument
// must be one of its hobs. Read-only access keeps the tools marked
// readOnlyHint, so every new tool is refused to it unless marked.
export function limitTools(server: McpServer, access: Access) {
  const register = server.registerTool.bind(server) as unknown as Register
  const limited: Register = (name, config, cb) => {
    const takesProject = config.inputSchema !== undefined && 'hob' in config.inputSchema
    const handler = takesProject
      ? (args: unknown, ...rest: unknown[]) => {
          const project = (args as { hob?: unknown }).hob
          if (typeof project === 'string' && !allowsProject(access, project)) {
            throw new ProjectError(`This connection has no access to the hob "${project}"`)
          }
          return cb(args, ...rest)
        }
      : cb
    const tool = register(name, config, handler)
    const readOnly = config.annotations?.readOnlyHint === true
    const limitedToHobs = access.projects !== null
    if (
      (access.readOnly && !readOnly) ||
      (limitedToHobs && (EVERY_PROJECT_TOOLS.has(name) || name.startsWith(HOUSE_TOOL_PREFIX)))
    ) {
      tool.disable()
    }
    return tool
  }
  server.registerTool = limited as unknown as McpServer['registerTool']
}
