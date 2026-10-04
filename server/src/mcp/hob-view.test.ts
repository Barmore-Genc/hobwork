import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Access } from '../access.ts'
import { createAgentToken } from '../agents.ts'
import { SHARE_PATH } from '../apps/http.ts'
import { createProject } from '../projects.ts'
import { createBranch } from '../repo.ts'
import { sendTo } from '../test-web.ts'
import { HOB_VIEW_URI, MCP_APP_MIME_TYPE } from './hob-view.ts'
import { startTestMcp, textOf, type TestMcp } from './test-mcp.ts'

// startTestMcp's host uses http://localhost, so apps live at *.apps.localhost.
const FILAMENT = 'http://filament.apps.localhost'

let mcp: TestMcp
const clients: Client[] = []

beforeEach(async () => {
  mcp = await startTestMcp()
  await createProject(mcp.host, 'filament')
  await createProject(mcp.host, 'alarms')
})

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  await mcp.close()
})

async function connect(access: Access) {
  const { token } = createAgentToken(mcp.host.db, `agent-${clients.length}`, access)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(mcp.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
  clients.push(client)
  return (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>
}

type Shown = { url: string; hob: string; branch: string; appOrigin: string; token: string; expiresAt: string; readOnly: boolean }

test('show_hob names the hob view, which may frame app origins only', async () => {
  const { tools } = await mcp.client.listTools()
  const tool = tools.find((t) => t.name === 'show_hob')!
  expect(tool._meta).toEqual({ ui: { resourceUri: HOB_VIEW_URI } })
  expect(tool.annotations?.readOnlyHint).toBe(true)

  const { resources } = await mcp.client.listResources()
  expect(resources).toContainEqual(expect.objectContaining({ uri: HOB_VIEW_URI, mimeType: MCP_APP_MIME_TYPE }))
  const { contents } = await mcp.client.readResource({ uri: HOB_VIEW_URI })
  expect(contents).toHaveLength(1)
  const view = contents[0]!
  expect(view.mimeType).toBe(MCP_APP_MIME_TYPE)
  expect(view._meta).toEqual({ ui: { prefersBorder: true, csp: { frameDomains: ['http://*.apps.localhost'] } } })
  expect('text' in view && view.text).toContain('ui/initialize')
})

test('show_hob returns a link that opens the app without signing in, with the link as text', async () => {
  const result = await mcp.call('show_hob', { hob: 'filament', path: '/spools/7?tab=1' })
  expect(result.isError).toBeFalsy()
  const shown = result.structuredContent as Shown
  expect(shown).toMatchObject({ hob: 'filament', branch: 'main', appOrigin: FILAMENT, readOnly: false })
  const url = new URL(shown.url)
  expect(`${url.origin}${url.pathname}`).toBe(`${FILAMENT}${SHARE_PATH}`)
  expect(url.searchParams.get('token')).toBe(shown.token)
  expect(url.searchParams.get('returnTo')).toBe('/spools/7?tab=1')
  expect(Date.parse(shown.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000)
  expect(textOf(result).split('\n')[0]).toBe(shown.url)
  expect(textOf(result)).toContain(`Bearer ${shown.token}`)

  const opened = await sendTo(mcp.url.origin, shown.url)
  expect(opened.status).toBe(302)
  expect(opened.headers.location).toBe('/spools/7?tab=1')
  expect(opened.headers['set-cookie']?.[0]).toMatch(/^hobwork_share=hws_/)
})

test('show_hob opens branch previews and refuses unknown branches and bad paths', async () => {
  await createBranch(mcp.host, 'filament', 'add-spools', 'main')
  const preview = (await mcp.call('show_hob', { hob: 'filament', branch: 'add-spools' })).structuredContent as Shown
  expect(preview.appOrigin).toBe('http://add-spools--filament.apps.localhost')

  const missing = await mcp.call('show_hob', { hob: 'filament', branch: 'nope' })
  expect(missing.isError).toBe(true)
  expect(textOf(missing)).toContain('does not exist')
  for (const path of ['//evil.example.com/', 'https://evil.example.com/', '/_hobwork/callback', 'spools']) {
    const bad = await mcp.call('show_hob', { hob: 'filament', path })
    expect(bad.isError, path).toBe(true)
  }
})

test('show_hob follows the access of the connection', async () => {
  const readOnly = await connect({ readOnly: true, projects: null })
  const shown = (await readOnly('show_hob', { hob: 'filament' })).structuredContent as Shown
  expect(shown.readOnly).toBe(true)
  expect(textOf(await readOnly('show_hob', { hob: 'filament' }))).toContain('read-only')

  const limited = await connect({ readOnly: false, projects: ['filament'] })
  expect((await limited('show_hob', { hob: 'filament' })).isError).toBeFalsy()
  const refused = await limited('show_hob', { hob: 'alarms' })
  expect(refused.isError).toBe(true)
  expect(textOf(refused)).toContain('no access')
})
