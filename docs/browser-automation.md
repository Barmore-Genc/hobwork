# Browser automation

Hobs drive a real Chrome to log into a site, fill a form, click through a flow and read a page that needs JavaScript. The browser runs on the host, outside every VM, and hob code talks to it over the [internal endpoint](architecture.md#internal-endpoint) like it talks to Home Assistant. Nothing from Playwright or Chromium is mounted into a guest.

Implemented. Where it lives:

- `server/src/browser/service.ts`: one browser, tabs per hob, idle stop, crash recovery, command queue.
- `server/src/browser/engine.ts`: patchright, the profile, and the navigation rules.
- `server/src/browser/xvfb.ts`: the display a headful browser needs on a server.
- `server/src/browser/internal.ts`, `commands.ts`, `allowlist.ts`: `POST /v1/browser`, field validation, declared sites.
- `server/src/browser/install.ts`, `server/src/cli/browser.ts`: `browser:install` and `browser:update`.
- `server/src/browser/approvals.ts`: the per-branch approval, next to Home Assistant's.
- `packages/sdk/src/webbrowser.ts`, `packages/sdk/src/runner/browser-client.ts`: `ctx.browser`.

## Decisions

- **One Chromium, one profile, one context, tabs for everybody.** Hobs share cookies, cache, consent state and logins. That is deliberate: a profile with history in it looks like a person's browser, and it is what makes logins survive. The cost is that the declared site list is the only separation between hobs: a hob that declares a site inherits whatever session another hob established there. Cookie isolation per hob was rejected because a fresh profile per hob is a fresh fingerprint per hob, and because `--load-extension` needs a persistent profile, and a persistent profile is one profile.
- **patchright** (`patchright` on npm, ~5k stars) as the engine. It is a patched copy of `playwright-core`, Apache-2.0, version-matched to upstream. It avoids the CDP `Runtime.enable` leak by evaluating JavaScript in isolated execution contexts, disables `Console.enable`, drops the library's launch-flag leaks, and pierces closed shadow roots. That leak is what Cloudflare, DataDome, Akamai and Kasada build their first signal on, and it cannot be fixed from inside a page. Rejected: `rebrowser-playwright-core` (same idea, fewer patches), and every JavaScript-injection stealth library (`playwright-stealth` and its upstream `puppeteer-extra-plugin-stealth`): they patch `navigator`, `chrome.*` and `Function.prototype.toString` in the main world, which is itself the fingerprint, and rebrowser measured that adding one to a patched Playwright turns their `nativeTampering` and `workerConsistency` checks red.
- **`channel: 'chromium'`**, the full Chrome for Testing build patchright downloads, not `chromium-headless-shell`. It takes uBlock Origin Lite, which the shell cannot.
- **Headful under Xvfb**, never `--headless`, on a Linux host. Patchright's maintainer: "Running Headless Chrome can always be detected without a Custom Compiled Chromium" ([#82](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/issues/82)). Measured here with Chrome 156: even the full build in new headless mode reports `HeadlessChrome/156.0.0.0` in the user agent. `HOBWORK_BROWSER_HEADLESS=1` still exists for a host with neither a display nor Xvfb, and the host logs a warning when it runs that way. Rejected: masking the token with `--user-agent`. Chrome's own user agent is the only one that agrees with `Sec-CH-UA`, the worker user agent and everything else, and patchright refuses to change it for the same reason.
- **The browser is a Linux desktop, not a fake Mac.** Faking macOS would mean faking `navigator.platform`, the user agent, `Sec-CH-UA-Platform`, `navigator.userAgentData.platform`, the font set, the text metrics that come out of CoreText rather than FreeType, `Intl`, `navigator.maxTouchPoints` and the WebGL renderer (ANGLE on Metal on an Apple GPU). Each of those is a lie a page can compare against the others, and the first missing macOS font places the browser on Linux anyway. So: the real user agent, `locale` and `timezoneId` set explicitly, a real window at `HOBWORK_BROWSER_WINDOW` (default 1920x1080) with `viewport: null`, and a normal desktop font set on the host (`fonts-liberation`, `fonts-dejavu-core`, `fonts-noto-core`, `fonts-noto-color-emoji`). WebGL falls back to SwiftShader and needs `--enable-unsafe-swiftshader` to exist at all; a software renderer is closer to a real Linux user than no WebGL. What patchright cannot fix stays unfixed: IP reputation and behaviour.
- **uBlock Origin Lite**, the newest MV3 build from `uBOL-home` releases, unpacked under the data dir and loaded with `--disable-extensions-except` and `--load-extension`. Its manifest declares `host_permissions: ["<all_urls>"]`, so the main rulesets (easylist, easyprivacy, ublock-filters and friends) filter without anyone granting anything; the annoyances lists, cookie banners among them, start off. A page cannot observe it, since its rules are declarativeNetRequest rather than content scripts. The host logs whether it loaded.
- **Screenshots are JPEG, with the fields a secret was typed into covered.** Pixels cannot be scrubbed like text, so the service remembers which selectors received a secret value and passes them to Playwright's `mask`, which paints a solid block over them. That answers the accidental leak the redaction filter exists for: a field showing a password. It cannot answer a page that prints the secret somewhere else (an error message, a canvas, an image), which is documented in the API and in the template `AGENTS.md`. JPEG at quality 80 keeps a 1920x1080 window at a few hundred KB, under the endpoint's result limit; the person who runs the host sees the same tabs without the blocks, since the pixels never reach a hob that way. No PDF, no downloads.

## Declared sites

`hobwork.json` gets a `browser` block, same entry syntax as `egress`:

```json
"browser": { "sites": ["shop.example.com", "*.example.org"] }
```

The list applies to **top-level navigations only**. Everything a page loads on its own (scripts, styles, fonts, XHR, websockets, iframes) is allowed, because blocking third-party resources breaks real sites and because CORS already stops a page from reading another origin's answers. Checked in the context's route handler on `request.isNavigationRequest()` with the frame being the page's main frame, so redirect chains, `location.href`, meta refresh, form posts and popups are checked. A refused navigation is aborted, Chromium shows its own error page, and the host writes a `browser-blocked` warn line naming the host and the line to add.

Rules on top:

- https only. Plain http is refused even for a declared host, and there is no localhost, `*.localhost`, `file:`, `chrome:`, `devtools:` or `about:` except blank.
- No proxy, no DNS check and no IP filtering, by decision. Consequences, for the record: a page can fire requests at LAN addresses through subresource URLs (CORS hides the answers, not the requests), and a declared host that resolves into the LAN is reachable.
- A tab is registered with its hob before its first navigation, so the first page is checked like any other.

## API

`ctx.browser` (`packages/sdk/src/webbrowser.ts`; the file name avoids `@hobwork/sdk/browser`, which is the route client for hob UIs):

```ts
const tab = await ctx.browser.open('https://shop.example.com/orders')
await tab.fill('css=#email', ctx.secrets.SHOP_EMAIL)
await tab.fill('css=#password', ctx.secrets.SHOP_PASSWORD)
await tab.click('role=button[name="Sign in"]')
await tab.waitFor('css=table.orders')
const rows = await tab.evaluate(() => [...document.querySelectorAll('tr')].map((r) => r.textContent))
await tab.close()
```

- `ctx.browser`: `open(url)`, `tabs()`, `tab(id)`.
- A tab: `goto`, `back`, `reload`, `click`, `hover`, `fill`, `type`, `press`, `select`, `waitFor`, `text`, `html`, `evaluate`, `url`, `title`, `screenshot`, `close`. Selectors go straight to Playwright, so `css=`, `text=`, `role=` and XPath all work.
- `evaluate` runs in patchright's isolated world by default, which is what keeps the `Runtime.enable` leak closed: it sees the DOM but not globals a page set. `{ world: 'main' }` reads those, and reopens the leak for that execution.
- Tabs outlive invocations. Tab IDs are opaque and belong to the hob and branch that opened them; the API has no browser-level close, so a hob cannot shut the browser down.
- Every command has a timeout (default 30 s, at most 120 s) and a hard ceiling 5 s above it, since Playwright does not time out `evaluate`. Every returned string is bounded, and a result over 2 MB is refused.

## Secrets

A `fill`, `type` or `press` may carry a secret placeholder: the runner sends its `ctx.secrets` map with the command, and the host swaps a placeholder for the real value, only when the tab's current origin host is one of the secret's hosts, the same rule `secretGuard` applies to `ctx.fetch`. The plaintext never enters the guest. Every string the host returns (text, html, `evaluate` results, error messages, URLs, titles) has any occurrence of any of the hob's secret values replaced with `[redacted]`, values shorter than 4 characters excepted, since they would redact ordinary page text.

This is aimed at accidental leaks: a page that transforms the value, or a hob that asks the page to encode it, gets through. It is not a boundary against a malicious hob working with a malicious site.

## Agents

Agents drive the same browser over MCP, in the same tabs and with the same profile, so a flow that logs in once works for both. The tools are `browser_open` (a new tab, or navigate one), `browser_act` (click, hover, fill, type, press, select, waitFor), `browser_read` (text, html, url, title), `browser_evaluate`, `browser_screenshot` (returned as image content in the tool result), `browser_tabs` and `browser_close` (`server/src/mcp/browser.ts`).

- The session is `{ project, branch }`: an agent working on a branch navigates the branch's tabs, and sees the sites the branch's committed `hobwork.json` declares.
- A branch preview needs `set_branch_browser`, the same approval a handler does, and the refusal says so.
- Everything an agent sees is redacted like a handler's answer, except the bytes of a screenshot, which cannot be.
- `browser_read`, `browser_tabs` and `browser_screenshot` are marked read-only, so a read-only credential keeps them: it can look at a tab a hob already has open, and cannot open one.

## Watching

The hob page shows the browser: each open tab with the version or branch that opened it, its address, and a picture of the page (`GET /api/projects/<hob>/browser` and `GET /api/projects/<hob>/browser/<tab>.jpg`, signed-in users only, `no-store`). It refreshes on a click and when the host publishes a `browser` change for tabs opening or closing, and it never interacts with the page: a person watches, the hob clicks.

## Endpoint

`POST http://hobwork.internal/v1/browser` with a `BrowserRequest` (`packages/sdk/src/runner/protocol.ts`), answered like `v1/ha`: `{ ok: true, result }` or `{ ok: false, error: { code, message } }`. Codes, with their HTTP statuses: `not_configured` 503, `not_allowed` 403, `not_approved` 403, `too_many_tabs` 429, `busy` 429, `timeout` 504, `selector_timeout` 504, `tab_gone` 410, `crashed` 503, `bad_request` 400, `host_error` 502. The SDK throws `BrowserError` with that code.

Access follows Home Assistant: the deployed version browses, a branch preview does only when "Let this branch use the browser" is on for it (`PUT|DELETE /api/projects/<name>/branches/<branch>/browser`, MCP tool `set_branch_browser`, checked on every command). Workspaces and pipeline VMs have no browser.

## Lifecycle and limits

- The browser starts with the first command and stops after `HOBWORK_BROWSER_IDLE` (default 10 minutes) with no commands, closing the context and Xvfb. The profile stays on disk. Tabs do not survive a stop, and a hob that acts on a dead tab gets `tab_gone`.
- Chromium's `SingletonLock` on the profile is what enforces one instance.
- Commands for one tab run in order and in parallel across tabs, with at most 4 waiting per tab (`busy` after that), `HOBWORK_BROWSER_MAX_TABS` per hob (default 8) and `HOBWORK_BROWSER_MAX_TABS_TOTAL` (default 32).
- `disconnected` marks the browser dead, forgets its tabs and logs it; the next command starts a new one.
- Logs: `browser` lines for opens and navigations at `info`, reads at `debug`, blocks and refusals at `warn` with `browser-blocked`, one line per command. Typed text is never logged.

## Install and updates

- `patchright` is the only new dependency, pinned exactly; it never downloads a browser on install.
- `pnpm -C server browser:install` (or `browser:update`) runs patchright's own installer with `PLAYWRIGHT_BROWSERS_PATH=<data>/browser/browsers`, then downloads the newest uBlock Origin Lite chromium zip and unpacks it into `<data>/browser/extensions/ublock-origin-lite`, recording the version beside it. `PLAYWRIGHT_BROWSERS_PATH` set by the operator wins, for a host that keeps its browsers elsewhere.
- Browser and extension updates ride patchright upgrades: the browser build has to match the driver, which is the point of not bundling one.
- The host answers `not_configured` with the command in the message when no browser is installed.
- Host requirements, documented rather than installed by Hobwork: `xvfb` and `unzip` on Linux, Chromium's system libraries (`playwright install-deps`), and the font packages above.
- The profile holds cookies and logins. Backups stage only the host DB, the repos, hob DBs, hob files and `secret.key`, so it never leaves the host, and `<data>/browser` is reinstallable.

## Tests

- Unit: `allowlist.test.ts`, `commands.test.ts`, `internal.test.ts`, `redact.test.ts` (the filter itself), `service.test.ts` (a fake engine for lifecycle, ownership, caps, queue, timeouts, crash, idle stop, secret hosts, screenshot masking), `server/src/mcp/browser.test.ts` (the agent tools: sites from the committed config, branch approval, request shapes, redaction, image results) and a route test for the hob page's tab list and picture.
- `runtime.test.ts` covers the wiring end to end on the host side: `/v1/browser` bound to the VM's hob, the committed `browser.sites`, secret values from the store, and a preview refused until its branch is approved. `engine.integration.test.ts` also takes a real screenshot and checks the bytes are a JPEG.
- `engine.integration.test.ts` boots a real browser against a local http server: launch, navigation rules, fill and click, text, `evaluate` in both worlds, profile persistence, uBlock Origin Lite loading, `navigator.webdriver`. Skipped unless asked:

  ```sh
  pnpm -C server browser:install
  HOBWORK_BROWSER_TESTS=1 pnpm -C server exec vitest run src/browser
  ```

- Fingerprint check, manual, after every patchright bump: `bot-detector.rebrowser.net`, `brotector`, `creepjs` and `browserleaks`, on a host with Xvfb.

## Later

- PDFs of a page, and downloads, if a hob ever needs them.
- A form of interaction from the hob page, rather than watching only.
- Choosing another Chrome channel from the web UI, instead of `HOBWORK_BROWSER_CHANNEL`.
