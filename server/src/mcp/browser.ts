import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'
import type { BrowserRequest } from '../../../packages/sdk/src/runner/protocol.ts'
import { BROWSER_MAX_TIMEOUT_MS, BrowserError } from '../../../packages/sdk/src/webbrowser.ts'
import { getBranchBrowserApproval } from '../browser/approvals.ts'
import { redact } from '../browser/redact.ts'
import type { BrowserSecret, BrowserService, BrowserSession } from '../browser/service.ts'
import type { Host } from '../host.ts'
import { DEFAULT_BRANCH, ProjectError, requireProject } from '../projects.ts'
import type { Runtime } from '../runtime/runtime.ts'
import type { SecretStore } from '../secrets.ts'
import { MAX_OUTPUT_CHARS, truncateMiddle } from './output.ts'

// The browser tools drive the same browser hobs use, in the same tabs and with
// the same profile, so an agent tests a flow with the logins a hob already has.
// The sites come from the committed hobwork.json of the version or branch, and
// a branch preview needs the approval a person sees on the hob page.

const hob = z.string().describe('Hob name, e.g. "filament-tracker"')
const branch = z
  .string()
  .optional()
  .describe(`Branch whose sites and tabs to use. Omit, or "${DEFAULT_BRANCH}", for the deployed version`)
const tabId = z.string().describe('Tab ID, from browser_open or browser_tabs')

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) }
}

function previewBranch(value: string | undefined): string | undefined {
  return value === undefined || value === DEFAULT_BRANCH ? undefined : value
}

export function registerBrowserTools(
  server: McpServer,
  options: { host: Host; browser?: BrowserService; runtime?: Runtime; secrets?: SecretStore },
) {
  const { host, browser, runtime, secrets } = options

  // Everything a call needs: the version or branch it acts as, the sites its
  // committed hobwork.json declares, and the secret values to scrub out of
  // what comes back.
  async function prepare(project: string, branchName: string | undefined) {
    requireProject(host, project)
    const branch = previewBranch(branchName)
    if (!browser) {
      throw new ProjectError(
        'This Hobwork host has no browser. Whoever runs Hobwork can install one with: pnpm -C server browser:install',
      )
    }
    if (!runtime) throw new ProjectError('This Hobwork host does not run hobs, so it cannot browse for them')
    if (branch !== undefined && getBranchBrowserApproval(host, project, branch) === undefined) {
      throw new ProjectError(
        `Branch "${branch}" may not browse the web. Turn it on with set_branch_browser, or ask the user to turn on "Let this branch use the browser" on the hob page in Hobwork`,
      )
    }
    const { config } = await runtime.config(project, branch)
    const session: BrowserSession = { project, ...(branch === undefined ? {} : { branch }) }
    const values: Record<string, BrowserSecret> = {}
    for (const [name, secret] of Object.entries(secrets?.forSandbox(project) ?? {})) {
      values[name] = { value: secret.value, hosts: secret.hosts }
    }
    return { session, sites: config.browser.sites, secrets: values }
  }

  async function run(project: string, branchName: string | undefined, request: BrowserRequest): Promise<unknown> {
    const prepared = await prepare(project, branchName)
    try {
      const result = await browser!.run({ ...prepared, request })
      // Agents see what an agent may see: the pixels of a screenshot are the
      // service's business (it masks what a secret was typed into), everything
      // else is scrubbed like a handler's answer.
      return request.action === 'screenshot' ? result : redact(result, prepared.secrets)
    } catch (err) {
      if (err instanceof BrowserError) throw new ProjectError(`${err.code}: ${err.message}`)
      throw err
    }
  }

  const sitesHint =
    'The sites it may open are "browser.sites" in the hob\'s hobwork.json, https only and never localhost. Ask the user before adding a site, and commit the change: a preview uses the branch\'s committed list'

  server.registerTool(
    'browser_open',
    {
      description: `Open a page in the browser the Hobwork host runs for hobs, or navigate a tab that is already open. Tabs are shared with the hob's handlers, so this is the browser a handler sees, with the logins it established, and it keeps them after it stops. ${sitesHint}. Returns the tab ID to use with the other browser tools.`,
      inputSchema: {
        hob,
        url: z.string().describe('An https URL on one of the sites the hob declares'),
        branch,
        tab: z.string().optional().describe('Navigate this tab instead of opening a new one'),
      },
    },
    async ({ hob: project, url, branch: branchName, tab }) => {
      const opened = (await run(project, branchName, { action: tab === undefined ? 'open' : 'goto', url, ...(tab === undefined ? {} : { tab }) })) as
        | { id: string; url: string; title: string }
        | null
      if (opened === null) return text(`Tab ${tab} is now at ${url}`)
      return text(`Tab ${opened.id} at ${opened.url}${opened.title ? ` (${opened.title})` : ''}`)
    },
  )

  server.registerTool(
    'browser_act',
    {
      description:
        'Act on a page: click, hover, fill, type, press, select or wait for an element. Selectors are Playwright\'s, so "css=#id", "text=Sign in", "role=button[name=\'Save\']" and XPath all work. fill and type replace the field\'s contents; press sends a key like Enter or Tab, to the element with selector or to whatever has focus. Each call waits for the element and fails with selector_timeout when it does not appear.',
      inputSchema: {
        hob,
        tab: tabId,
        action: z.enum(['click', 'hover', 'fill', 'type', 'press', 'select', 'waitFor']),
        branch,
        selector: z.string().optional().describe('The element. Required for every action except press without one'),
        text: z.string().optional().describe('For fill and type'),
        key: z.string().optional().describe('For press, like "Enter"'),
        values: z.array(z.string()).optional().describe('For select: the option values to select'),
      },
    },
    async ({ hob: project, tab, action, branch: branchName, selector, text: value, key, values }) => {
      const need = (what: string, given: string | undefined) => {
        if (given === undefined) throw new ProjectError(`${action} needs ${what}`)
        return given
      }
      const element = () => need('selector', selector)
      const request = ((): BrowserRequest => {
        switch (action) {
          case 'click':
            return { action, tab, selector: element() }
          case 'hover':
            return { action, tab, selector: element() }
          case 'waitFor':
            return { action, tab, selector: element() }
          case 'fill':
            return { action, tab, selector: element(), text: value ?? '' }
          case 'type':
            return { action, tab, selector: element(), text: value ?? '' }
          case 'select':
            return { action, tab, selector: element(), values: values ?? [] }
          case 'press': {
            const pressed = need('key', key)
            return { action, tab, key: pressed, ...(selector === undefined ? {} : { selector }) }
          }
        }
      })()
      await run(project, branchName, request)
      return text(`${action} done in tab ${tab}`)
    },
  )

  server.registerTool(
    'browser_read',
    {
      description:
        'Read a page: its visible text (text), its HTML (html), its address (url) or its title (title). Text is what a person sees, so it is usually the cheapest way to scrape a list. Secret values are replaced with [redacted] before they reach you. Use browser_evaluate for data only the page\'s own scripts have.',
      inputSchema: {
        hob,
        tab: tabId,
        what: z.enum(['text', 'html', 'url', 'title']),
        branch,
        timeoutMs: z.number().int().min(1).max(BROWSER_MAX_TIMEOUT_MS).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ hob: project, tab, what, branch: branchName, timeoutMs }) => {
      const value = await run(project, branchName, { action: what, tab, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      return text(truncateMiddle(String(value), MAX_OUTPUT_CHARS))
    },
  )

  server.registerTool(
    'browser_evaluate',
    {
      description:
        'Run a JavaScript function in the page and get its JSON result back, for data the page keeps in its own scripts. Pass the function as source, like "() => [...document.querySelectorAll(\'tr\')].map((r) => r.textContent)" or "(tag) => document.querySelector(tag).textContent", and arg when it takes one. By default it runs in an isolated world, which sees the DOM but not globals the page set; world "main" reads those, and makes the browser easier to detect for that call. Secret values are replaced with [redacted].',
      inputSchema: {
        hob,
        tab: tabId,
        script: z.string().describe('The function source, e.g. "() => document.title"'),
        branch,
        arg: z.unknown().optional().describe('The argument the function receives'),
        world: z.enum(['isolated', 'main']).optional().describe('Default: isolated'),
      },
    },
    async ({ hob: project, tab, script, branch: branchName, arg, world }) => {
      const value = await run(project, branchName, {
        action: 'evaluate',
        tab,
        source: script,
        ...(arg === undefined ? {} : { arg }),
        ...(world === undefined ? {} : { world }),
      })
      return text(truncateMiddle(JSON.stringify(value ?? null, null, 2), MAX_OUTPUT_CHARS))
    },
  )

  server.registerTool(
    'browser_screenshot',
    {
      description:
        'A JPEG of the tab as the browser draws it, for a layout or a page that hides things from the DOM. Fields the hob typed a secret into are covered with a solid block; a page that prints the secret elsewhere (an error, a canvas) still shows it, so read text instead when you only need words.',
      inputSchema: {
        hob,
        tab: tabId,
        branch,
        fullPage: z.boolean().optional().describe('The whole page instead of the window. Long pages are refused'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ hob: project, tab, branch: branchName, fullPage }) => {
      const value = await run(project, branchName, { action: 'screenshot', tab, ...(fullPage ? { fullPage: true } : {}) })
      return { content: [{ type: 'image', data: String(value), mimeType: 'image/jpeg' }] }
    },
  )

  server.registerTool(
    'browser_tabs',
    {
      description: `The tabs open in the browser for this hob and branch, or all of the hob's when branch is omitted, with their addresses. A hob's tabs outlive its invocations, so this is how you find the one a handler is in the middle of.`,
      inputSchema: { hob, branch },
      annotations: { readOnlyHint: true },
    },
    async ({ hob: project, branch: branchName }) => {
      const tabs = (await run(project, branchName, { action: 'tabs' })) as { id: string; url: string; title: string }[]
      if (tabs.length === 0) return text('No tabs are open.')
      return text(tabs.map((entry) => `${entry.id}  ${entry.url}${entry.title ? `  (${entry.title})` : ''}`).join('\n'))
    },
  )

  server.registerTool(
    'browser_close',
    {
      description:
        'Close a tab the hob opened. Whatever it was in the middle of is lost and the session it had on that site stays in the profile, so only close a tab you are done with.',
      inputSchema: { hob, tab: tabId, branch },
    },
    async ({ hob: project, tab, branch: branchName }) => {
      await run(project, branchName, { action: 'close', tab })
      return text(`Closed tab ${tab}`)
    },
  )
}
