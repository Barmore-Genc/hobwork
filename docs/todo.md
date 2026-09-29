# TODO

## Security hardening

From the security audit of 2026-09-29. Two threats, in order of how they arrive:

- **A bug in agent-written hob code** that someone outside finds and exploits: a webhook or route that reflects input into HTML, XSS in a hob UI, an injection that runs code in the runtime VM, SSRF through a handler. The goal is that one buggy hob cannot reach Hobwork, other hobs, secret values, or more of the house than it needs.
- **A malicious dependency.** Agents add npm packages to hobs. A package's code runs in workspace VMs (tests, dev servers, install scripts the hob allows), pipeline VMs (tests, build), the runtime VM (handlers) and the browser (hob UIs).

The principle for the larger items: the host never reads, writes or runs git on files a VM can write. That work moves into the VM, and the host takes back only data it can check.

Sections are in the order to work on them.

### Quick fixes

- **Webhook and route response headers**: handler responses on the Hobwork origin (`/hooks/`, `/p/<hob>/api`) get `Content-Security-Policy: sandbox; default-src 'none'` and `X-Content-Type-Options: nosniff`, and lose `Set-Cookie`. Tested with a branch webhook and a route whose handler returns HTML with a script and a cookie, and by checking that such a page cannot call `/api` as the user.
- **Session token on `hobwork.internal`**: workspace VMs' `/v1/db`, `/v1/ha` and `/v1/devices` require `HOBWORK_SESSION`, like the CLI routes.
- **Reading `hobwork.json` and `package.json` from workspaces**: open with `O_NOFOLLOW`, require a regular file, cap the size. Replaced later by reading them from git or the VM.
- **AI usage accounting**: the gateway always sets `usage: { include: true }`, whatever the guest sent.

### Limiting a compromised hob

- **Default CSP for hob UIs**: app origins serve hob UIs and route responses with a strict CSP (`script-src 'self'`, no inline scripts, `object-src 'none'`, `base-uri 'none'`) and `nosniff`, so most XSS bugs in agent-written UIs cannot run script. `hobwork.json` can loosen it for a hob that needs to.
- **Runtime VM lifetime**: a runtime VM serves invocations for up to its idle timeout (default 1 hour), so code that gets in through one invocation sees later ones (other webhooks, notification actions, HA events). Cap a runtime VM's total lifetime, and replace it after an invocation times out or the runner crashes.
- **HA service calls**: see Home Assistant below. It is the main limit on what a compromised handler can do in the house.

### Supply chain

- **Release age**: set pnpm's `minimumReleaseAge` in the guest image's global pnpm config, so versions published in the last few days are not installed. Most malicious releases are caught and pulled within that time. The pipeline refuses a hob whose `pnpm-workspace.yaml` lowers it.
- **Install scripts**: pnpm runs dependency lifecycle scripts only for packages the hob's `pnpm-workspace.yaml` allows. Show changes to that list in the version diff, and keep the platform default empty.
- **Frozen lockfile**: pipeline and build installs use `--frozen-lockfile`, so what was tested is what gets deployed.

### Nothing on the host touches guest-writable files

- **Workspace git in the VM**: `commit`, `diff` and `changes` run git inside the workspace VM, and a commit reaches the bare repo by pushing over git smart HTTP through `hobwork.internal` with the session token. The pre-receive hook already refuses `main`. Today a nested repo's config (`core.fsmonitor`, filter drivers) runs on the host during `git add` and `git status`; in the VM, submodule recursion keeps working and runs where workspace code already runs.
- **Migrations in the VM**: migrations run in a VM against a copy of the hob DB, instead of `db.exec` on the host, where they can `ATTACH` other DBs and write files with `VACUUM INTO`. Covers workspace `/v1/db`, branch previews, the merge dry run and deploy. The host opens the returned DB with `O_NOFOLLOW`, requires a regular file under a size cap, runs `PRAGMA integrity_check` and swaps it in atomically.
- **File tools in the VM**: `read_file`, `write_file`, `edit_file`, `delete_file`, `list_files` and `search` run inside the workspace VM. The host's check-then-open on the checkout races with symlinks the guest swaps in. Needs the workspace VM running for reads, so it depends on the VM budget below.
- **Build copy after the VM stops**: stop the pipeline VM before `saveBuild`, and copy with `O_NOFOLLOW`.

### Origins and headers

- **Webhooks on the apps host**: serve `/hooks/` from the apps host, and stop answering it on the Hobwork origin.
- **CSP and nosniff everywhere**: a `script-src` CSP on the UI, and `nosniff` on the JSON API and hob icons.
- **Cross-app requests**: an app's `hobwork.json` lists the hobs whose apps may send it requests (`crossAppRequests`); others are refused on every method, including GET. Blocked by default.
- **Host allowlist**: answer 421 for hosts other than the public host and app hosts.
- **Apps URL**: document that the public host must not be at or below the apps host.

### Home Assistant, AI and secrets

- **HA service calls**: a per-hob list of the HA domains and services handlers may call, changeable in the UI and over MCP. Empty by default, so a hob calls no services until its list names them. Hobs deployed before this get a list of the domains they already call. Supervisor and core admin services (`hassio.*`, `homeassistant.*`, `recorder.purge`) stay blocked on the host.
- **AI endpoints**: refuse gateway paths it does not recognize, and estimate the cost from tokens when OpenRouter returns none.
- **AI over https only**: the interceptor refuses plain http.
- **Secret substitution**: only into named headers (`Authorization` and those a secret lists) over https.

### Resources

- **Bounded output**: pipeline step output streams to the log store; bash results keep a head and a tail; the log line splitter has a maximum line length; the runner response has a size limit.
- **VM resources and budget**: `hobwork.json` can ask for less memory and fewer vCPUs per VM kind, never more than the defaults. Starting a VM reserves its resources from a global memory and vCPU budget. When the budget is full, requests wait in per-hob queues with an equal share per active hob, borrowing idle capacity; idle workspace VMs over their share stop first. The main runtime goes first, then builds and previews, then workspaces. Waits end with a "host busy" error.
- **Webhook token first**: check the webhook token before resolving a branch label, which runs git.
- **OAuth limits**: key IPv6 rate limits by /64, and evict the oldest unapproved clients and requests instead of refusing new ones.
- **Log rate limit**: per-VM limit on log lines outside invocations.
- **`idleTimeout`**: clamp it below `setTimeout`'s maximum.

### Guest privilege

Everything in a workspace VM runs as root, so any process (a dependency's install script, a test) can read the agent's `HOBWORK_SESSION` from `/proc` and merge. Run agent commands as an unprivileged guest user, keep the session token in a root-owned helper that only the `hobwork` CLI reaches, and set `kernel.yama.ptrace_scope` to 1 and `hidepid=2` on `/proc`. Needs an image rebuild.

### Egress

Check whether a guest reaches LAN devices' global IPv6 addresses or NAT64 addresses through the egress check. If so, pass Gondolin an `isIpAllowed` hook that refuses the host's LAN prefixes and those ranges.

### Sign-in

- **OIDC flow state on the server**: the flow cookie holds an opaque ID instead of the state, so app subdomains cannot plant a flow. Requests with a security cookie name more than once are treated as signed out.
- **One identity per issuer**: once a user is linked to an issuer, only that `(issuer, sub)` signs in as them; a new subject from the same issuer with the same email is refused.
- **No http outside dev**: refuse to start with an `http` public URL unless it is loopback.
- **`/auth/link`**: the same `Sec-Fetch-Site` check as `/auth/device`.
- **Consent default**: the MCP consent page starts on read-only access.
- **Device pairing redirect**: a universal link instead of `hobwork://paired`.
- **NFC page**: a missing `Sec-Fetch-Site` counts as cross-site and shows the Run button.
- **OAuth metadata fetch**: block `64:ff9b:1::/48`, `2002::/16` and IPv4-compatible IPv6 addresses.

### Sandbox account

The Gondolin VFS provider runs in the host's Node process and QEMU is its child, both as the `hobwork` user that owns the data dir and `secret.key`. A VFS race or a QEMU escape is then a full compromise. Run QEMU and the VFS as another account, one per VM or per hob so a sandbox cannot reach other hobs' workspaces, and add QEMU `-sandbox on`. On `colossus` the host is a systemd service as `hobwork` with `NoNewPrivileges=yes`, so it cannot switch users itself. Options: a `hobwork-vm@.service` template with `DynamicUser=yes` that the host starts through a polkit rule limited to those units, or a small privileged launcher. The mounted directories then need to move out of the `700` data dir or be handed over as open file descriptors. Linux production only; macOS dev keeps the in-process sandbox. Needs a design spike first.

### Smaller items

- Document that `HOBWORK_TRUSTED_PROXIES` must list only proxies.
- Match the branch too when attaching runner log lines to an invocation.
- Auth on the runner's ingress port.
- Hide the `ha_*` tools from credentials limited to some hobs.
- Read-only tools read from git instead of opening a workspace.
- Refuse any git HTTP path ending in `git-receive-pack` for read-only tokens.

## Warm VM pool

Keep one booted spare VM per kind (runtime, workspace, pipeline) so a cold start takes an exec instead of a boot. Boot is about 0.7s on `colossus` and 0.5s on the Mac; a running VM answers a command in a few ms. Each spare costs about 175MB of host RSS. The spare has to be configured for the hob after boot (mounts, env, egress allowlist, secrets), so the `Sandbox` interface needs a way to apply these to a running VM, or the pool holds VMs per hob that is likely to start soon.

Other boot costs left, smaller and with more upkeep: a custom `rootfsInit` in the image (no debug output, parallel `modprobe`, no `update-ca-certificates` at boot), about 100-200ms; a custom kernel with the virtio and fuse drivers built in.

## Checking hobs against a new guest image

A platform set or SDK update takes effect for every hob at once, on its next workspace, pipeline run or build. Before switching to a new image, run every hob's pipeline against it. Hobs that fail stay on the old image until an agent fixes them, which needs images to be versioned and hobs to record the image they were tested with.

## claude.ai connectors

Connecting Hobwork as a custom connector in claude.ai, Claude Desktop and Cowork needs the host on public https. The OAuth flow is tested with the MCP SDK client and Claude Code only; check it end to end with claude.ai.

## Interrupting runaway queries

A hob DB query that runs longer than 30s is abandoned by terminating its worker, since SQLite cannot be interrupted from Node. Interrupt the query instead once Node exposes a way to (SQLite's `sqlite3_interrupt` or a progress handler), so the connection survives.

## More Home Assistant commands in `ctx.ha`

`ctx.ha` has service calls, states and events. Add `render_template` and other useful HA WebSocket commands.

## Home Assistant integration

A custom HA integration (installed through HACS) that exposes Hobwork handlers as HA services or entities, so they can be used from the HA automation editor.

## OpenRouter

- Streaming responses from the OpenRouter helper. The AI gateway gets answers to the guest only when they are complete, since Gondolin buffers answers from its `onRequest` hook; streaming needs Gondolin to pass a response body stream through.
- A spend limit across all hobs, next to the per-hob ones.
- Spend limits can be passed by one request, since cost is known only afterwards. Estimating a request's cost from `max_tokens` and the model's prices before sending it would close that gap.
- Tell people when a hob reaches a limit (a notification to their devices), not only in the hob log.

## Checking push notifications on a device

The host's APNs client is tested against a local HTTP/2 server, and the Apple app with unit tests and `just test-host` (`just test-host-mac` on macOS). Check APNs delivery and the web view sign-in on a real iPhone, and on a Mac with a team-signed build: the macOS app has only run signed ad hoc (`just run-mac local`), which gets no push token, no app group and no data protection keychain.

## Shared UI components

There is no component library in core; hob UIs use the theme's Tailwind utilities. If agents keep rewriting the same components across hobs, ship them in the platform set.

## Screen Time without the Family Controls entitlement

Last resort if Apple rejects the Family Controls distribution entitlement. No third-party blocker (Opal, one sec, Jomo, Brick, AppBlock, Freedom, [Foqos](https://github.com/awaseem/foqos)) has a remote API; they run on the device with the same entitlement, and their only integration point is their Shortcuts actions (App Intents). The Hobwork app cannot call another app's intents, but it can open `shortcuts://run-shortcut?name=<name>`, which runs a Shortcut the person built around the blocker's actions (for example Foqos "Start session").

- The app still sends no `screenTime` capability. A new capability maps set names to Shortcut names the person enters in the app's settings, one to block and one to unblock.
- A call arriving while the app is in the foreground opens the Shortcut. Otherwise the host sends a notification, and tapping it opens the app, which opens the Shortcut. The notification service extension cannot open URLs, so this always needs a tap.
- Schedules and limits are left to the blocker app or to Shortcuts personal automations (time of day, Focus, NFC), which run without Hobwork. Hobwork only knows the state if the Shortcut reports it back, for example through a Hobwork App Intent it calls last.
