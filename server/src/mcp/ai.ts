import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod'
import type { AuthenticatedAgent } from '../agents.ts'
import {
  AiSettingsError,
  applyOverrides,
  checkModels,
  hostAiSettings,
  parseDecisionModel,
  parseModel,
  projectAiSettings,
  updateHostModels,
  updateProjectModels,
  type AiConfig,
  type ModelOverrides,
} from '../ai/settings.ts'
import type { Host } from '../host.ts'
import { ProjectError, requireProject } from '../projects.ts'

const overrides = ({ model, decisionModel, embeddingModel, visionModel }: ModelOverrides) => ({ model, decisionModel, embeddingModel, visionModel })

// Agents may change which models hobs use, but not the request and spend limits.
export function registerAiTools(server: McpServer, { host, agent, ai }: { host: Host; agent: AuthenticatedAgent; ai: AiConfig }) {
  server.registerTool(
    'set_ai_model',
    {
      description:
        "Set the OpenRouter models hobs use. Hobwork picks the model for every OpenRouter request a hob makes: `model` for chat and the other text endpoints, `decisionModel` for check, pick and the Decisions API, `embeddingModel` for embed and the embeddings endpoint, `visionModel` for chat requests that ask for it with `model: 'vision'` (reading photos and other images). Changing the embedding model makes new embeddings incomparable with ones a hob stored before. With a hob, sets that hob's own models; without, the host-wide models every hob without its own uses, which needs access to all hobs. Each field: an OpenRouter model ID to set it, null to use the level above (the hob the host-wide model, the host its built-in default), or leave it out to keep it. Takes effect on the hob's next request, without a merge. get_hob shows the models a hob uses.",
      inputSchema: {
        hob: z.string().optional().describe('Hob name. Leave out for the host-wide models'),
        model: z.string().nullable().optional().describe('Chat model ID, e.g. "deepseek/deepseek-v4.1-flash"'),
        decisionModel: z
          .union([z.string(), z.literal(false)])
          .nullable()
          .optional()
          .describe('Decision model ID, e.g. "typesafe/jev-1.13". false: no decision model, so check and pick run on `model`'),
        embeddingModel: z.string().nullable().optional().describe('Embedding model ID, e.g. "openai/text-embedding-3-small"'),
        visionModel: z.string().nullable().optional().describe('Model ID for chat requests with `model: \'vision\'`, one that reads images, e.g. "google/gemini-3.1-flash-lite"'),
      },
    },
    async ({ hob: name, model, decisionModel, embeddingModel, visionModel }) => {
      if (name === undefined && agent.access.projects !== null) {
        throw new ProjectError('Only connections with access to all hobs can change the host-wide models. Pass a hob to set its own.')
      }
      let changes: Partial<ModelOverrides>
      try {
        changes = {
          ...(model !== undefined && { model: parseModel(model) }),
          ...(decisionModel !== undefined && { decisionModel: parseDecisionModel(decisionModel) }),
          ...(embeddingModel !== undefined && { embeddingModel: parseModel(embeddingModel, 'embeddingModel') }),
          ...(visionModel !== undefined && { visionModel: parseModel(visionModel, 'visionModel') }),
        }
        await checkModels(ai, changes)
      } catch (err) {
        if (err instanceof AiSettingsError) throw new ProjectError(err.message)
        throw err
      }
      const by = { agentId: agent.id }
      const hostChoice = () => applyOverrides(ai.models, hostAiSettings(host.db))
      let result: unknown
      if (name === undefined) {
        updateHostModels(host.db, changes, by)
        result = { host: overrides(hostAiSettings(host.db)), uses: hostChoice() }
      } else {
        const { id } = requireProject(host, name)
        updateProjectModels(host.db, id, changes, by)
        const own = projectAiSettings(host.db, id)
        result = { hob: overrides(own), uses: applyOverrides(hostChoice(), own) }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )
}
