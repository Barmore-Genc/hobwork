# Browser automation

Hobs can drive a real Chrome to log into a site, fill a form, click through a flow and read a page that needs JavaScript. The browser runs on the host, outside every VM, and hob code talks to it over the [internal endpoint](architecture.md#internal-endpoint) like it talks to Home Assistant. Nothing from Playwright or Chromium is mounted into a guest.

Design decisions and the reasons for them, so they are not re-litigated. Not implemented yet.

## Decisions

- **One Chromium, one profile, one context, tabs for everybody.** Hobs share cookies, cache, consent state, extension state and `localStorage`. That is deliberate: a profile with history in it looks like a person's browser, and it is what makes logins survive. The cost is that the declared site list is the only separation between hobs: a hob that declares a site inherits whatever session another hob established there. Cookie isolation per hob was rejected because a fresh profile per hob is a fresh fingerprint per hob, and because `--load-extension` (uBOLite) needs a persistent profile, and a persistent profile is one profile.
- **patchright** (`patchright` on npm, ~5k stars). It is a patched copy of `playwright-core`, Apache-2.0, version-matched to upstream. It avoids the CDP `Runtime.enable` leak by evaluating JavaScript in isolated execution contexts, disables `Console.enable`, drops the library's launch-flag leaks (`--enable-automation` removed, `--disable-blink-features=AutomationControlled` added, `--disable-extensions`, `--disable-component-update` and `--disable-default-apps` removed) and pierces closed shadow roots. That leak is what Cloudflare, DataDome, Akamai and Kasada build their first signal on, and it cannot be fixed from inside a page. Rejected: `rebrowser-playwright-core` (same idea, fewer patches), and every JavaScript-injection stealth library (`playwright-stealth` and its upstream `puppeteer-extra-plugin-stealth`). Those patch `navigator`, `chrome.*` and `Function.prototype.toString` in the main world, which is itself the fingerprint: a page that checks property descriptors and native function text finds them, and their own maintainer calls them a proof of concept. Rebrowser measured that adding the stealth plugin to its patched Playwright turns their `nativeTampering` and `workerConsistency` checks red.
- **Headful under Xvfb, never `--headless`.** Patchright's maintainer on why headless is a dead end: "Running Headless Chrome can always be detected without a Custom Compiled Chromium" ([#82](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/issues/82)), and headless leaks `HeadlessChrome` in the user agent and in worker user agents even with `channel: 'chrome'` ([#227](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/issues/227)). Headful under Xvfb has no headless flag, no headless user agent and a real window size. On Linux the host starts `Xvfb :<n> -screen 0 <window>x24 -nolisten tcp` with the browser and stops it with the browser. On a machine with a real display (development on the Mac) the browser opens a window in it, and `HOBWORK_BROWSER_HEADLESS=1` forces headless where Xvfb is not available, accepting the leak.
- **The browser is a Linux desktop, not a fake Mac.** Faking macOS means faking `navigator.platform`, the user agent, `Sec-CH-UA-Platform` and `navigator.userAgentData.platform`, the font set, the text metrics that come out of CoreText rather than FreeType, `Intl`, `navigator.maxTouchPoints` and the WebGL renderer (ANGLE on Metal on an Apple GPU). Each of those is a lie a page can compare against the others, and the first missing macOS font is enough to place the browser on Linux anyway. Copying Apple fonts to the server is also a licensing question and only covers the handful of fonts that get copied. A plain Linux desktop with the real user agent is consistent by construction, and consistency is what survives scrutiny. So: `channel: 'chromium'` (Chrome for Testing, the full browser, not `chromium-headless-shell`), the user agent it reports, `locale` and `timezoneId` set explicitly, a common `viewport`, and a normal desktop font set (`fonts-liberation`, `fonts-dejavu-core`, `fonts-noto-core`, `fonts-noto-color-emoji`) so text renders like a desktop instead of a container. WebGL falls back to SwiftShader and needs `--enable-unsafe-swiftshader` to exist at all; a software renderer string is closer to a real Linux user than no WebGL. What patchright cannot fix stays unfixed: IP reputation, and behaviour. Its maintainer says as much on Cloudflare failing in CI ([#224](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/issues/224)).
- **uBlock Origin Lite**, the MV3 extension, downloaded from `uBOL-home` releases and unpacked under the data dir, loaded with `--disable-extensions-except` and `--load-extension`. Extensions need a persistent context and Playwright's bundled Chromium: Google Chrome and Edge removed the flags that side-load unpacked extensions. A page cannot observe uBOLite, since it is declarativeNetRequest rules rather than content scripts, and command-line flags are only visible in the process list.
- **No screenshots, no PDF, no downloads.** Screenshots would hand the hob pixels that the redaction filter cannot touch. Downloads would write host files.

## Declared sites

`hobwork.json` gets a `browser` block, same entry syntax as `egress` (host, `*.example.com`, `host:port`), parsed by the same code:

```json
"browser": { "sites": ["shop.example.com", "*.example.org"] }
```

The list applies to **top-level navigations only**. Everything a page loads on its own (scripts, styles, fonts, XHR, websockets, iframes) is allowed, because blocking third-party resources breaks most real sites and because CORS already stops a page from reading another origin's answers. Checked on `request.isNavigationRequest()` with `request.frame() === page.mainFrame()`, so redirect chains, `location.href`, meta refresh, form posts and popups are all checked. The block answers as a navigation error and writes a `browser-blocked` warn line naming the host and the line to add.

Rules on top:

- https only. Plain http is refused even for a declared host, and there is no localhost, `*.localhost`, `file:`, `chrome:`, `devtools:` or `about:` except `blank`.
- No proxy, no DNS check and no IP filtering, by decision. The browser's own defences are what a subresource gets. Consequences, for the record: a page can still fire requests at LAN addresses through subresource URLs (CORS hides the answers, not the requests), and a declared host that resolves into the LAN is reachable.

## API

`ctx.browser` (`packages/sdk/src/webbrowser.ts`, so it does not collide with `@hobwork/sdk/browser`, which is the route client for hob UIs):

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
- A tab: `goto`, `back`, `reload`, `click`, `hover`, `fill`, `press`, `select`, `waitFor`, `text`, `html`, `evaluate`, `url`, `title`, `close`. Selectors go straight to Playwright, so `css=`, `text=`, `role=` and XPath all work.
- `evaluate` runs in patchright's isolated world by default, which is what keeps the `Runtime.enable` leak closed. Reading main-world globals (`window.someData` a page wrote) needs `{ world: 'main' }` on the call, which reopens the leak for that execution, so the default stays isolated.
- Tabs outlive invocations. Tab IDs are opaque and belong to the hob that opened them; the API has no browser-level or context-level close, so a hob cannot shut the browser down.
- Every command has a timeout (default 30 s, at most 120 s), every returned string is bounded like command output, and returning values pass the redaction filter.

## Secrets

A `fill`, `type` or `press` may carry a secret placeholder. The host substitutes the real value, and only when the tab's current origin host is one of the secret's hosts, the same rule as `secretGuard` for `ctx.fetch`. The plaintext never enters the guest. Every string the host returns (text, html, `evaluate` results, error messages, URLs, titles) passes a filter that replaces any occurrence of any of the hob's secret values with `[redacted]`. This is aimed at accidental leaks: a page that transforms the value, or a hob that asks the page to encode it, gets through. It is not a boundary against a malicious hob working with a malicious site.

## Endpoint

`POST http://hobwork.internal/v1/browser` with a `BrowserRequest` (`packages/sdk/src/runner/protocol.ts`), answered like `v1/ha`: `{ ok: true, result }` or `{ ok: false, error: { code, message } }`. Error codes: `not_configured` (the host has no browser installed, or browsing is off), `not_allowed` (the host is not in `browser.sites`), `not_approved` (preview branch, see below), `busy`, `timeout`, `tab_gone`, `crashed`, `bad_request`. The SDK throws `BrowserError` with that code.

Access follows Home Assistant: the deployed version gets the browser, a branch preview gets it only when "Let this branch browse the web" is on for that branch (`PUT|DELETE /api/projects/<name>/branches/<branch>/browser`, MCP tool `set_branch_browser`, checked on every command), and workspaces and pipeline VMs get `read_only`/nothing for now.

## Lifecycle and limits

- `server/src/browser/`: `service.ts` (launch, idle stop, crash recovery, Xvfb child), `tabs.ts` (ownership, per-hob tab sets), `commands.ts` (validation and execution), `allowlist.ts` (reuses `parseEgressEntry`/`hostMatches`), `internal.ts`, `config.ts`.
- The browser starts on the first command and stops after `HOBWORK_BROWSER_IDLE` (default 10 minutes) with no commands, closing the context and Xvfb. The profile stays on disk. Tabs do not survive a stop, and a hob that acts on a dead tab gets `tab_gone`.
- Chromium's `SingletonLock` on the profile is what enforces one instance.
- Commands run one at a time per tab and in parallel across tabs, with a cap of `HOBWORK_BROWSER_MAX_TABS` (default 8 per hob, 32 in all).
- `browser.on('disconnected')` marks the session dead, and the next command relaunches.
- Logs: `browser` lines for opens, navigations and failures at `info`, blocks and refusals at `warn` with `browser-blocked`, one line per command at `debug`.

## Install and updates

- `playwright-core` is not a dependency; `patchright` is, pinned exactly. It never downloads a browser on install.
- `pnpm -C server browser:install` runs patchright's own installer with `PLAYWRIGHT_BROWSERS_PATH=<data>/browser/browsers` (`channel: 'chromium'`), then downloads the newest uBOLite Chromium zip from `uBOL-home` and unpacks it under `<data>/browser/extensions/ublock-origin-lite`, recording both versions. `browser:update` repeats it. The host answers `not_configured` with that command in the message when the browser is missing.
- Browser and extension updates therefore ride patchright upgrades, which is the point of not bundling a browser: the version has to match the driver. A hob's browser lifecycle never downloads anything on its own.
- Host requirements, documented for the operator rather than installed: `xvfb` on Linux, Chromium's system libraries (`playwright install-deps`), and the font packages above. uBOLite updates its filter lists over the network from the profile.

## Storage and backup

`<data>/browser/profile` (mode 700) holds cookies and logins. It is excluded from the Kopia backups: a restore should not resurrect dead sessions, and cookies in an S3 bucket are a liability. `<data>/browser/browsers` and `<data>/browser/extensions` are also excluded, since they are reinstallable.

## Tests

- Unit: allowlist matching and navigation classification, command validation, tab ownership and caps, redaction, secret substitution rules, `internal.ts` endpoint shape and codes.
- Lifecycle: a fake browser factory for launch, idle stop, crash, relaunch and tab caps.
- Integration (`browser.integration.test.ts`, skipped by `pnpm test`, run with browsers installed): real patchright plus a local https server, covering navigation blocking, redirects, popups, subresource loads from an undeclared host, secret substitution and redaction.
- Fingerprint check, manual: `bot-detector.rebrowser.net`, `brotector`, `creepjs` and `browserleaks` against the installed profile after a release, since every patchright bump can regress them.

## Phases

1. `hobwork.json` `browser` block, SDK types, `ctx.browser` with a fake in `testing.ts`, endpoint answering `not_configured`, unit tests.
2. Service: launch, Xvfb, persistent profile, uBOLite, idle stop, tabs, commands, redaction, secrets.
3. Navigation allowlist and logging, preview-branch approval (API, MCP tool, hob page switch), project page listing the declared sites.
4. `browser:install`/`browser:update` CLI, host requirements in the operator docs, integration test.
5. Later: the same commands over MCP for agents in workspaces, a read-only live view of a tab on the hob page.
