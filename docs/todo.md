# TODO

## Security hardening

From the security audit of 2026-09-29. Two threats, in order of how they arrive:

- **A bug in agent-written hob code** that someone outside finds and exploits: a webhook or route that reflects input into HTML, XSS in a hob UI, an injection that runs code in the runtime VM, SSRF through a handler. The goal is that one buggy hob cannot reach Hobwork, other hobs, secret values, or more of the house than it needs.
- **A malicious dependency.** Agents add npm packages to hobs. A package's code runs in workspace VMs (tests, dev servers, install scripts the hob allows), pipeline VMs (tests, build), the runtime VM (handlers) and the browser (hob UIs).

The principle for the larger items: the host never reads, writes or runs git on files a VM can write. That work moves into the VM, and the host takes back only data it can check.

Sections are in the order to work on them.

### Limiting a compromised hob

- **Default CSP for hob UIs**: app origins serve hob UIs and route responses with a strict CSP (`script-src 'self'`, no inline scripts, `object-src 'none'`, `base-uri 'none'`) and `nosniff`, so most XSS bugs in agent-written UIs cannot run script. `hobwork.json` can loosen it for a hob that needs to.

### Supply chain

- **`.pnpmfile.cjs`**: a hob's pnpmfile is code that runs during install and gets around `allowBuilds`. The pipeline refuses hobs that have one, or runs installs with `--ignore-pnpmfile`.
- **Install script changes in the UI**: a merge that changes `allowBuilds` gets a notice in its pipeline output. The web UI has no version diff to show it in; add one, or a flag on the version in `list_versions` and the versions list.

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

- **HA events**: `fireEvent` is not limited by the services list, and events can trigger HA automations. Give hobs a list of event types they may fire, like the services list.
- **Secret refusals in the hob log**: a request refused because a secret is in the wrong header or goes over http writes a hob log line, like `egress-blocked`.
- **AI gateway port**: refuse OpenRouter on ports other than 443.

### Resources

- **Pipeline output in the log store**: pipeline step output streams to the log store line by line, instead of a 2,000-character summary per step. Memory is already bounded (head and tail).
- **VM resources and budget**: `hobwork.json` can ask for less memory and fewer vCPUs per VM kind, never more than the defaults. Starting a VM reserves its resources from a global memory and vCPU budget. When the budget is full, requests wait in per-hob queues with an equal share per active hob, borrowing idle capacity; idle workspace VMs over their share stop first. The main runtime goes first, then builds and previews, then workspaces. Waits end with a "host busy" error.

### Guest privilege

Everything in a workspace VM runs as root, so any process (a dependency's install script, a test) can read the agent's `HOBWORK_SESSION` from `/proc` and merge. Run agent commands as an unprivileged guest user, keep the session token in a root-owned helper that only the `hobwork` CLI reaches, and set `kernel.yama.ptrace_scope` to 1 and `hidepid=2` on `/proc`. Needs an image rebuild.

### Sandbox account

The Gondolin VFS provider runs in the host's Node process and QEMU is its child, both as the `hobwork` user that owns the data dir and `secret.key`. A VFS race or a QEMU escape is then a full compromise. Run QEMU and the VFS as another account, one per VM or per hob so a sandbox cannot reach other hobs' workspaces, and add QEMU `-sandbox on`. On `colossus` the host is a systemd service as `hobwork` with `NoNewPrivileges=yes`, so it cannot switch users itself. Options: a `hobwork-vm@.service` template with `DynamicUser=yes` that the host starts through a polkit rule limited to those units, or a small privileged launcher. The mounted directories then need to move out of the `700` data dir or be handed over as open file descriptors. Linux production only; macOS dev keeps the in-process sandbox. Needs a design spike first.

### Smaller items

- Read-only tools read from git instead of opening a workspace.

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
