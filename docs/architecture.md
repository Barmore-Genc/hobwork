# Hobwork architecture

Hobwork is a personal code engine for a household. You (or an AI agent working for you) put scripts, scheduled jobs, HTTP APIs and small dashboards into it, and it runs them. Everything is reachable over MCP, so an agent can build and maintain automations end to end: write code, write tests, run them, merge, deploy, and debug from logs.

Named after hobs, the house spirits that quietly do chores around the home.

## Goals

- Agents can create and change automations without a human reviewing code.
- Changes never break what is running without tests having run first.
- Every deployed version is recoverable with one click.
- Scripts run sandboxed, with controlled network access and secrets they can use but never read.
- Dashboards look like part of one app and work in the browser and in the Apple apps.
- Scripts can reach the phone: notifications, NFC, alarms, Screen Time.

## Non-goals

- Multi-tenant hosting or scaling. Each project runs as zero or one instance.
- Protecting against hostile users. Users are a household. The sandbox protects against buggy or misled agent code.
- Replacing a general app platform. Dashboards are small internal UIs.

## Components

```
                 +-------------------------------------------------+
  Browser  ----> |                 Hobwork host                    |
  Apple apps --> |  HTTP API / web UI / dashboards                 |
  Agents (MCP)-> |  MCP server                                     |
  git push ----> |  git smart HTTP                                 |
  ssh ---------> |  SSH gateway                                    |
                 |                                                 |
                 |  repos (bare git)   host DB (SQLite)            |
                 |  project DBs        scheduler / event bus       |
                 +-----------+-------------------------------------+
                             | Gondolin (QEMU + KVM/HVF)
            +----------------+----------------+
            |                |                |
      project runtime   agent workspace   pipeline run
      VM (0 or 1 per    VM (per branch)   VM (fresh per
      project)                            run)
```

- **Host**: Node (>= 24.12 for `node:sqlite`'s authorizer and defensive mode, runs TypeScript directly), pnpm. One process. Runs as a systemd service on `hobwork-host` (Arch Linux, x86_64, KVM). Docker is possible with `--device /dev/kvm` but not the primary target.
- **Web UI**: React, TypeScript, Tailwind, Vite. Served by the host.
- **Guest image**: a Hobwork-specific Gondolin image built from Alpine with Node, pnpm, git, e2fsprogs and the platform dependency set including `@hobwork/sdk` and `@hobwork/theme` (`images/`, built inside Docker by `images/build.sh`). VMs grow the root disk at boot (`diskSize`); root disk writes are discarded when a VM stops.
- **SDK** (`@hobwork/sdk`): the library project code imports to talk to the host (storage, logs, secrets-aware fetch, devices, calling other projects).
- **Apple apps**: iOS and macOS (maybe tvOS later). Bundle ID prefix `dev.bgenc.hobwork`. A WebView for dashboards plus native capabilities exposed to scripts.

The host never executes project code itself. Anything from a project repo runs inside a Gondolin VM.

## Sandboxing (Gondolin)

[Gondolin](https://github.com/earendil-works/gondolin) runs each sandbox as a QEMU micro-VM. The host implements the guest's network stack and filesystem in TypeScript, which gives us:

- **Egress allowlist**: only HTTP(S) to allowed hosts. Blocked requests get a 403. Internal ranges are blocked by default.
- **Secret placeholders**: the guest sees `GONDOLIN_SECRET_...` in env vars. The host swaps in the real value in request headers, only for the hosts the secret is bound to. Query string substitution is off.
- **Mounts**: host directories or in-memory filesystems mapped into the guest.
- **Ingress**: HTTP gateway into a server listening on `127.0.0.1` in the guest.

Gondolin does not work under Bun (HTTPS egress hangs, gondolin#73), which is why the host is Node.

All Gondolin use goes through a small `Sandbox` interface in the host (`server/src/sandbox/sandbox.ts`) so the backend can be swapped (e.g. Docker) if it ever needs to be. It covers: create a VM (memory, CPUs, disk size, image, mounts, env, egress allowlist, secrets, internal host handler), exec with streamed output, timeout and kill, ingress to a guest port, file read/write, and stop. `@earendil-works/gondolin` is pinned to an exact version because the project is young and changes often.

- **Exec** runs `/bin/sh -lc <command>`. Several commands can run at once in one VM, including next to a long-running server.
- **Kill and timeout**: Gondolin cannot signal a guest process (aborting an exec only stops waiting). Every exec gets a unique `HOBWORK_EXEC_ID` env var, which child processes inherit. A kill runs a second exec that finds the processes with that variable in `/proc/*/environ` and sends SIGTERM, then SIGKILL after 2s. This also catches children that started their own session.
- **Blocked egress** is reported to the host through a callback (for logging). Gondolin checks its allowlist only after resolving the name, so a host that does not resolve would get a 502 and never reach the callback. The sandbox therefore checks the hostname against the allowlist first (`isRequestAllowed`, same pattern matching as Gondolin), which answers 403 and reports it.

Measured with `pnpm -C server bench:sandbox` (Hobwork image, Gondolin 0.12.0, 512MB / 2 vCPU VMs) on an Apple Silicon Mac (M-series, 14 cores, HVF):

| | |
|---|---|
| Create to first command | median 470ms (360-500ms) |
| Command on a running VM | median 2ms |
| `node -e 0` in guest | median 29ms |
| 10 concurrent `sleep 1` in one VM | 1.1s total |
| Host RSS per VM | 262MB fresh, 444MB after running tsc and node |
| 8 VMs in parallel | ready in 1.1s, 2.1GB host RSS total |
| HTTPS GET through egress proxy | curl median 36ms, node fetch 177ms including node startup |

Measured the same way on `hobwork-host` (Arch Linux, AMD, 16 CPUs, 27GB RAM, KVM, Node 26), run directly on the bare host (`-accel kvm -cpu host` confirmed in the QEMU command line):

| | |
|---|---|
| Create to first command | median 731ms (611-955ms) |
| Command on a running VM | median 4ms |
| `node -e 0` in guest | median 46ms |
| 10 concurrent `sleep 1` in one VM | 1.1s total |
| Host RSS per VM | 175MB fresh, 289MB after running tsc and node |
| 8 VMs in parallel | ready in 1.4s, 1.4GB host RSS total |
| HTTPS GET through egress proxy | curl median 44ms, node fetch 155ms including node startup |

On x86_64 the host replaces Gondolin's kernel command line (`server/src/sandbox/gondolin.ts`). With the default one, create to first command took 2.5s:

- QEMU's `microvm` machine has no CMOS RTC, and the kernel's `rtc_cmos` probe waits about 1.3s before it gives up (`initcall_blacklist=cmos_init`).
- The i8042 probe costs about 80ms (`i8042.noaux i8042.nomux i8042.nopnp`).
- Kernel and init output go to the emulated UART, and every byte is a VM exit. That is about 450ms (`quiet`, `console=tty0`). `HOBWORK_VM_CONSOLE=1` puts the console back on `ttyS0`, so Gondolin's boot error messages include the guest log.

The rest is SeaBIOS (about 125ms; qboot measured no faster), the kernel, and Gondolin's init script (module loading, DHCP, sandboxfs mount, CA bundle). The VM test suite (`pnpm -C server test:vm`) passes on `hobwork-host` (55 tests).

### VM kinds

| Kind | Lifetime | Filesystem | Purpose |
|---|---|---|---|
| Project runtime | 0 or 1 per project. Starts on demand, stops after idle timeout | Deployed build of `main`, read-only | Runs handlers |
| Agent workspace | Per branch. Stops when idle, restarts on demand | Branch checkout, read-write | Agent bash, dev server, tests while iterating |
| Pipeline run | Fresh per run, discarded after | Clean checkout of the candidate commit | Install, typecheck, lint, test, build |
| Branch preview | 0 or 1 per branch. Starts on demand, stops after idle timeout | Build of the branch's latest commit, read-only | Runs a branch's handlers for its preview |

## Projects

A project is a git repository plus its deployed state, data and secrets. Examples: "filament tracker", "sleep alarms", "HA announcements".

### Repository layout

New projects are created from a template with everything configured:

```
AGENTS.md              how Hobwork works, rules for agents (Lambda model, tests, migrations)
hobwork.json           entry points (crons, webhooks, routes, triggers) and settings
package.json           scripts: typecheck, lint, test, build; extra deps (discouraged)
tsconfig.json
vite.config.ts         UI build + Vitest config
src/                   handlers and shared code
ui/                    dashboard pages (React + Tailwind)
migrations/*.sql       project DB migrations, applied in order
tests/                 Vitest tests
```

### Entry points

All entry points are declared in `hobwork.json`. The host reads it directly and never has to run project code to find out what a project does. The pipeline validates it against a JSON schema.

```json
{
  "crons": {
    "morning-alarm": { "schedule": "0 6 * * 1-5", "handler": "src/morning-alarm.ts" }
  },
  "webhooks": {
    "filament-scanned": { "handler": "src/scan.ts" }
  },
  "routes": {
    "GET /spools": { "handler": "src/spools.ts" }
  },
  "triggers": {
    "desk-button": {
      "homeassistant": {
        "trigger": "device",
        "domain": "zha",
        "device_id": "...",
        "type": "remote_button_short_press",
        "subtype": "button_1"
      },
      "handler": "src/desk-button.ts"
    }
  },
  "egress": ["api.example.com"],
  "idleTimeout": "1h"
}
```

- **Crons**: run on a schedule. The host owns the schedule.
- **Webhooks**: called from outside at `/hooks/<project>/<name>/<token>`. The token is a rotatable secret. The request is passed to the handler.
- **Routes**: authenticated API for the project's own dashboard, at `/api/...` on the project's app origin (see [Project app origins](#project-app-origins)) and at `/p/<project>/api/...` on the Hobwork host for agents. `"GET /spools/:id"` answers `GET /api/spools/42` with `ctx.params.id = "42"`. Static segments win over parameters, and `HEAD` is served by the `GET` route.
- **Triggers**: events from integrations (Home Assistant, devices). The trigger payload is passed to the handler. A trigger has either a `homeassistant` block or a `device` block; `{ "device": { "capability": "notifications", "event": "action" } }` runs when someone taps an action on a notification the project sent (see [Notifications](#notifications)).

A handler file exports a default function that receives the invocation context:

```ts
import type { Handler } from "@hobwork/sdk";

export default (async (ctx) => {
  const res = await ctx.fetch("https://health-export.example/api/sleep/last");
  ...
}) satisfies Handler;
```

The context (`packages/sdk/src/index.ts`) has `invocation` (ID, kind, name, whether it was started by hand), `request` (a standard `Request`, for routes and webhooks), `params`, `payload` (trigger variables, or what a manual invocation passed), `fetch` (the guest's own `fetch`, which the egress allowlist controls), `log`, `db`, `ha`, `secrets`, and `device(name)` and `devices()` (see [Devices](#devices-apple-apps)). `RequestHandler` is the variant with `request` always set. A route or webhook answers with the handler's return value: a `Response` is sent as is, `undefined` as 204, anything else as JSON. A thrown error answers 500 with the invocation ID and no details, since webhook callers are outside the household; the error and stack trace are in the invocation record.

The SDK API is the context rather than imported functions, so handler bundles contain no SDK runtime code and tests build a context by hand.

### Dependencies

The guest image contains one **platform dependency set** (React, Tailwind, Vite, Vitest, TypeScript, oxlint, zod, date-fns and similar) on the VM's own disk. Every project uses the same versions, so they are updated together.

- Updating the platform set means a new image version. Before switching, Hobwork runs every project's pipeline against the new image. Projects that fail stay on the old image until an agent fixes them.
- Projects can add extra npm packages in their `package.json`, installed on top of the platform set. This is allowed but discouraged, and `AGENTS.md` says so.

How the layering works (prototyped in `server/src/sandbox/gondolin.test.ts`):

- The platform set is a normal pnpm install at `/opt/hobwork/platform` (`images/platform/package.json` and its lockfile, exact versions). `/node_modules` is a symlink to `/opt/hobwork/platform/node_modules`, and `/opt/hobwork/platform/node_modules/.bin` is on `PATH`.
- Node, TypeScript, Vite and Vitest all resolve packages by walking up parent directories to `/node_modules`, so a project anywhere in the VM finds the platform packages and their types with no configuration. `NODE_PATH` is not used because ES modules ignore it.
- A project's `package.json` lists only its extras (the template has scripts and no dependencies). `pnpm install` puts them in the project's own `node_modules`, which is found before `/node_modules`, so an extra could also override a platform package.
- `images/platform/package.json` is the single definition of the platform set. The host reads it (`server/src/platform.ts`) to tell extras apart: a dependency not in it (and not `@hobwork/sdk`) is an extra. Workspace and pipeline VMs run `pnpm install` only when a project has extras.
- The template sets `autoInstallPeers: false` in `pnpm-workspace.yaml`. Without it, pnpm installs a second React for an extra that has React as a peer dependency. With it, the peer resolves to the platform React through the same parent-directory lookup.
- Installing extras needs egress to `registry.npmjs.org`. Egress is fixed when a VM is created, so pipeline VMs can reach the registry (and nothing else) for the whole run, not only during the install step. Workspace VMs can reach it too, so agents can `pnpm add` extras.

`@hobwork/sdk` is part of the platform set. The image build copies `packages/sdk` (its `package.json`, `src/` and schema) to `/opt/hobwork/platform/node_modules/@hobwork/sdk`, so project code resolves it through `/node_modules` like any platform package, in workspace, pipeline and runtime VMs alike. It is versioned with the image: an SDK change needs an image rebuild, and every project's pipeline runs against the new SDK before it switches, the same as for other platform updates. Rejected: mounting `packages/sdk` from the host read-only, which would let the SDK drift from what a deployed version was tested against. The SDK is shipped as TypeScript source. That works for types and for Vite builds, and handler bundles contain no SDK runtime code (see [Entry points](#entry-points)), so nothing is compiled. The runner in `packages/sdk/src/runner/` is host code and reaches runtime VMs differently (see [Runtime](#runtime)).

### Workspace file layout

Agent workspaces mount the branch checkout from the host read-write at `/workspace`, so the host (MCP file tools, git) and the VM see the same files. `node_modules` inside it lives on the VM's own disk (a bind mount the `Sandbox` sets up for `Mount.vmDisk` paths, hidden from the host side). It only holds extras, is reinstalled when the VM starts, and is gone when it stops.

Measured with `pnpm -C server bench:sandbox vfs` on the Mac (generated project: 40 TSX modules using zod, date-fns and React, 20 Vitest files; 2GB VM; medians of 3):

| Layout | `tsc --noEmit` 2 vCPU | `vitest run` 2 vCPU | `tsc --noEmit` 4 vCPU | `vitest run` 4 vCPU |
|---|---|---|---|---|
| (a) everything mounted, full `node_modules` in the mount | 1.79s | 23.3s | 1.55s | 11.4s |
| (b) everything on the VM disk | 0.90s | 12.7s | 0.74s | 5.1s |
| (c) source mounted, platform set from the image | 0.95s | 12.2s | 0.78s | 5.3s |
| (d) source mounted, full `node_modules` on the VM disk | 0.96s | 12.2s | 0.83s | 5.3s |

- The Gondolin filesystem bridge doubles the time when `node_modules` goes through it, and copying the platform set into a mount takes 10s. With `node_modules` on the VM disk, a mounted checkout is as fast as a checkout on the VM disk, so there is no reason to copy the checkout into the VM.
- Vitest time is dominated by module imports, not the filesystem: every test file runs isolated and imports `date-fns` from scratch (~750ms in the guest, ~420ms in a Docker container on the same Mac). `--no-isolate` brings the run to 1.2s. Pipeline and workspace VMs get 4 vCPUs.
- The template's Vitest config sets `isolate: false`, with `restoreMocks`, `unstubGlobals` and `unstubEnvs` so mocks and stubs do not leak between tests. On the template with 10 extra test files importing zod and date-fns (4 vCPUs): 3.6-3.9s isolated, 3.0-3.7s with `pool: 'threads'`, 0.8s with `isolate: false`. Test files share one module cache, which `AGENTS.md` tells agents.

### Branches and workspaces

- Each project is a bare repo on the host: `data/repos/<project>.git`.
- `main` is the deployed version. Nobody pushes to it directly. The only way in is a merge through the pipeline.
- Agents do work on branches. Each branch can have an **agent workspace** VM with the branch checked out.
- A workspace's checkout lives on the host at `data/workspaces/<project>/<branch>/`, with the branch's files in `files/` and the git directory in `git/`. The VM mounts only `files/`. The host runs all git commands for the workspace (`commit`, `diff`, `log`) with an explicit git directory, so nothing the VM writes (git config, hooks, filters) is ever executed on the host. `commit` pushes to the branch in the bare repo.
- Branch data is isolated: a workspace gets a copy of the project DB taken when the workspace VM starts. Tests get an empty DB with migrations applied. See [Data](#data).

Workspace VMs (`server/src/guest-vm.ts`):

- Started by the first `bash` call on a branch: 4 vCPUs, 2GB memory, 4GB root disk, `files/` at `/workspace` with `node_modules` on the VM disk. `bash`'s `cwd` is relative to `/workspace`. Extras are installed on start. A failed install does not fail the start, so the agent can still run commands and see the error with `pnpm install`.
- Egress: the branch's `hobwork.json` `egress`, the hosts of the project's secrets, and `registry.npmjs.org`. Secrets are passed as placeholders like in the runtime. When `egress` or the secrets change, the next `bash` call replaces the VM (unless a command is still running), so agents can test a new host without a restart tool. Blocked requests are logged to the project log with the branch name.
- Idle stop: a VM with no `bash` call for `HOBWORK_WORKSPACE_IDLE_MINUTES` (default 30) is stopped, unless a command is running. Every `bash` call updates `last_used_at` when it starts and when it ends. The default is well above the 10 minute `bash` timeout. A stopped VM starts again on the next call. Stopping loses processes and the VM-disk `node_modules`, and nothing else, since the files are on the host.
- The host stops all workspace and pipeline VMs on SIGINT and SIGTERM.
- Pipeline VMs use the same resources and layout with a fresh VM per run and only the registry allowed.
- Both are enabled when a guest image exists (`images/build/<arch>` or `HOBWORK_IMAGE_DIR`). Without one the host logs that `bash` and `merge` are unavailable.

### Deleting projects

Only people delete projects, in the web UI (the project's overview, confirmed by typing the name) through `DELETE /api/projects/<name>` with `{ confirm: "<name>" }`. There is no MCP tool, CLI command or workspace API for it: an agent that is misled or confused could otherwise destroy a project and its data, and deleting is rare enough to leave to a person.

Deletion (`server/src/project-deletion.ts`) runs in the project's delivery queue, so it waits for a running merge or restore. It stops the runtime VM right away without waiting for running invocations, unschedules crons, unsubscribes HA triggers (`removeProject` in the trigger registry), stops and removes branch workspaces (VMs, checkouts, branch DBs), closes the project DB, and deletes the builds. The project row goes from the host DB and takes versions, pipeline runs, invocations, logs, webhook tokens, workspaces and secret assignments with it (foreign keys cascade). Secrets stay in the library for other projects.

It is a soft delete for the parts that cannot be rebuilt: the bare repo and the project DB directory move to `<dataDir>/trash/<name>-<time>/` (`repo.git`, `data/`) with a `deleted.json` listing the versions and who deleted it. The daily housekeeping job (`server/src/housekeeping.ts`) removes entries older than 7 days. Backups may run less often than a project gets deleted by mistake, and they cover live projects only (snapshots from before the deletion keep it for their retention), so the trash is the way back in the meantime; bringing a project back is a manual step on the host (move the repo and DB back, then create the project row and versions). The name can be used for a new project right away.

## Agent access

Three ways in. All of them act on the same repos and workspaces.

1. **MCP** (primary; the only option for Claude Cowork and chat clients). See the tool list below.
2. **git smart HTTP**: `git clone https://hobwork/git/<project>.git`, work locally with Claude Code, push a branch. A pre-receive hook rejects pushes to `main`. After pushing, the agent calls `merge` over MCP (or over SSH).
3. **SSH gateway**: `ssh <project>/<branch>@hobwork` opens a shell in that branch's workspace VM. Also provides a `hobwork` CLI inside workspaces (`hobwork merge`, `hobwork logs -f`, `hobwork status`). See [SSH gateway](#ssh-gateway).

### MCP tools

Projects: `list_projects`, `create_project` (from template), `get_project` (entry points, current version, status, the app URL and each branch's preview URL).

Workspaces and files: `create_branch`, `list_branches` (with each branch's app URL), `read_file`, `write_file`, `edit_file`, `delete_file`, `list_files`, `search`, `bash` (runs in the branch workspace VM), `commit`, `diff`, `log`.

Delivery: `merge` (runs the pipeline, squash-merges and deploys on success, returns failures otherwise), `pipeline_status`, `list_versions`, `restore_version`.

Runtime: `invoke` (call a route or run a cron, webhook or trigger by hand, on `main` or with `branch` on a branch preview), `list_invocations` (filter by `branch`), `get_logs`, `tail_logs`, `rotate_webhook_token` (with `branch`, a URL for the branch preview).

Secrets: `list_secrets` (the library: names, hosts and assignments, never values), `assign_secret` and `unassign_secret`. Only users create secrets and set values and hosts. See [Secrets and network](#secrets-and-network).

SSH keys: `add_ssh_key`, `list_ssh_keys` and `revoke_ssh_key`, for the calling agent's own keys. See [SSH gateway](#ssh-gateway).

Home Assistant: `ha_list_devices`, `ha_list_entities`, `ha_get_state`, `ha_list_services`, `ha_list_device_triggers` (ready-made trigger definitions for a device), `ha_get_automation` (an automation's or script's config, whether it is on and when it last ran), `ha_find_related` (the automations and scripts that use a device or entity, and the other way round), `ha_list_traces` and `ha_get_trace` (recent runs of an automation or script, step by step), `ha_history` (state changes from the recorder), `ha_logbook` (changes and events with what caused them), `ha_system_log` (HA's own warnings and errors), `ha_list_statistics` and `ha_statistics` (long-term statistics per 5 minutes, hour, day, week or month), and `ha_listen` (wait for a trigger to fire, so an agent can ask the user to press a button and see the resulting payload). Listings take filters and are paged, since real installs have thousands of entities. All of these are read-only and use HA's WebSocket API, some of it admin-only, so the HA token must belong to an administrator. Times from HA (seconds or milliseconds since the epoch) are returned as ISO 8601. Traces are looked up by the automation's `id` from its config, so automations without one have none.

Devices: `list_devices` (names, owners, capabilities, connection). Read-only; see [Devices](#devices-apple-apps).

The MCP server's instructions point agents to the project's `AGENTS.md` and explain the core rules.

The endpoint is streamable HTTP at `/mcp`, stateless (a fresh server per request), authenticated with a bearer token: a static agent token or an OAuth access token (see MCP auth under [Users and authentication](#users-and-authentication)). File tools act on the branch workspace checkout on the host and reject paths and symlinks that lead outside it. `main` is readable through a host-only checkout reset to the branch tip on each read. Writes, `bash` and `commit` on `main` are refused. `search` matches in a worker thread with a deadline, so an agent-supplied regular expression cannot block the host. `bash` runs through the workspace VM's `exec` (see `ExecWorkspaceVm` in `server/src/workspaces.ts`) with a timeout, and long output is cut in the middle.

### SSH gateway

`server/src/ssh/`, on `HOBWORK_SSH_PORT` (default 2222, `off` disables it), built on the `ssh2` package (pure JavaScript; its optional native `cpu-features` build is not allowed in `pnpm-workspace.yaml`). The host key is an Ed25519 key generated on first start at `data/ssh_host_ed25519_key` (mode 0600).

- **Auth**: public keys only, each registered to an agent (`agent_ssh_keys`: name, key type, base64 key data, SHA-256 fingerprint, comment, where it was added and by whom, `revoked_at`). Every key has a name. Revoked keys keep their row, and a key can be added again once its earlier row is revoked. Users add and revoke keys with `POST /api/agents/<id>/ssh-keys` (`{ name, publicKey }`) and `POST /api/ssh-keys/<id>/revoke`; `GET /api/agents` lists them per agent with `addedFrom`. Agents manage their own keys over MCP: `add_ssh_key(name, public_key)`, `list_ssh_keys` and `revoke_ssh_key(id)`, only for their own agent. A key an agent adds records the agent token or OAuth grant it used, and revoking that token or grant revokes the key, so cutting off an agent's access also cuts off the SSH keys it gave itself. Keys added by a user or on the host are not tied to a token or grant. Without the web UI: `pnpm --filter @hobwork/server add-ssh-key <agent-name> <key-name> [key.pub]` (creates the agent if needed, reads stdin without a file).
- **User name** is the target: `<project>/<branch>`. OpenSSH accepts a slash in the user name (checked with OpenSSH 10.3). `<project>+<branch>` works too, for clients or URLs where a slash is awkward. Project names contain neither character and branch names cannot contain `+`, so the first `/` or `+` splits. The target is checked after authentication, so a bad target gets a message rather than a bare "Permission denied".
- **Sessions**: a shell (`exec bash --login`) or `ssh host '<command>'` runs in the branch's workspace VM with `/workspace` as the working directory, starting the VM like `bash` does. Gondolin supports stdin, a PTY and PTY resize on an exec, so interactive shells get a real terminal with the client's `TERM` and window size, and window changes follow. Without a PTY request (`ssh host cmd`, `ssh -T`) stdin, stdout and stderr stay separate and binary-safe. The exit status is passed back. A dropped connection kills the command (same `/proc` environ kill as `bash`). `main` is refused like `bash` on `main`. Port forwarding, agent forwarding, X11, SFTP and git over SSH are not supported.
- **Idle stop**: a session counts as a running command, so the VM is not stopped while it lasts, and `last_used_at` is updated when it starts and ends.

**`hobwork` CLI** (`packages/sdk/src/cli/main.ts`): `status` (branch head, uncommitted changes, `main`'s version and what is deployed, last pipeline run of the branch, the app URLs of the branch and `main`), `diff`, `commit "<message>"`, `merge "<summary>"`, `logs [-f] [-n N]`, `invocations [-n N]`. A merge failure exits with status 1, usage errors with 2. The workspace has no git directory, so `hobwork commit` is how SSH users commit.

- **Delivery**: mounted read-only from the host at `/opt/hobwork/cli`, with a `/usr/local/bin/hobwork` wrapper written when the VM starts. Like the runtime runner, it speaks the host's internal API and so has to match the host version; baking it into the image would need a rebuild for every API change. It uses only Node built-ins.
- **Endpoint**: the workspace VM's internal handler (`server/src/workspace-api.ts`), bound to the VM's project and branch, answers `/v1/workspace/*` at `hobwork.internal`. The CLI uses `node:http`, since `fetch` gives up waiting for response headers after 5 minutes and a merge can take longer. `logs -f` long-polls with a cursor (up to 30 seconds per request).
- **Identity**: the agent that runs the command. A workspace VM is shared by every agent working on the branch, so binding an agent to the VM would credit one agent with another's commit or merge. Every SSH session and every MCP `bash` call opens a workspace session: a random token, valid while the command runs, passed as `HOBWORK_SESSION`. Child processes inherit it, the CLI sends it back in `x-hobwork-session`, and the handler accepts it only for its own workspace. Calls without a valid token (e.g. from a background process that outlived its session) are refused. Other processes in the same VM could read a token from `/proc`; that is within the household trust model (see [Non-goals](#non-goals)).

### Rules for agents

Written into `AGENTS.md` in every project and into the MCP server instructions:

- Handlers are like AWS Lambda functions. Nothing in memory survives between invocations. Store state with the SDK (project DB).
- Every change needs tests. `merge` runs typecheck, lint, tests and build, and refuses on failure.
- Migrations are forward-only and additive (add tables and columns, do not drop or rename), so older versions keep working after a restore.
- Use `get_logs` and `list_invocations` to debug. Do not guess.
- There are no long-running processes. Anything that needs to persist goes in the project DB.
- Prefer the platform dependency set. Add extra packages only when nothing in it does the job.

## Delivery pipeline

`merge` on a branch:

1. Start a fresh pipeline VM with the candidate: the branch rebased (or merged) onto current `main`.
2. Validate `hobwork.json`.
3. Install extra dependencies, if the project has any. Platform packages are already in the image.
4. `typecheck`, `lint`, `test`, `build` (package.json scripts from the template). `build` bundles handlers and dashboards with Vite.
5. Apply new migrations to a copy of the production DB, as a dry run (see [Data](#data)).
6. On success: squash-merge into `main` with the agent's summary as the commit message, apply migrations for real, deploy.
7. On failure: return the failing step with its output to the agent. No human is involved. The agent fixes and calls `merge` again.

There is no human approval step. Users see the result as a new version in the UI.

Pipeline runs are recorded (step, status, output, duration) and visible to agents through `pipeline_status`.

Details:

- `merge` takes only committed changes and refuses while the workspace has uncommitted ones.
- The candidate is built in a temporary host-side clone: the branch is squashed into one commit (author: the agent, committer: Hobwork, message: the agent's summary) and rebased onto `main`. Squashing first means only the branch's end result has to apply. On conflict, the conflicting files are returned and the agent redoes the change on a new branch from `main`.
- Merges and restores run one at a time per project, so each candidate is tested against the `main` it lands on.
- The pipeline VM gets a clean checkout of the candidate with no git directory. `hobwork.json` and `package.json` are read on the host from git, never from the checkout. Extra dependencies are the `package.json` dependencies not in the platform set (see [Dependencies](#dependencies)).
- After a successful merge, the branch and its workspace checkout are reset to the new `main` (ignored files like `node_modules` stay), so the agent can keep working on the same branch. If the branch changed while the merge ran, it is left as it was.
- The pipeline VM backend is a seam (`StartPipelineVm` in `server/src/pipeline/runner.ts`), implemented on the `Sandbox` in `server/src/guest-vm.ts`. `server/src/pipeline/host-backend.ts` runs commands on the host without a sandbox and exists only for tests.

## Versions and rollback

- Every merge is one squash commit on `main` = one version. Version 1 is the template commit from project creation.
- The UI lists versions with their summaries. "Restore this version" commits that version's tree as a new commit on `main`, records it as a new version and deploys it, without running the pipeline. History is never rewritten.
- Restoring code does not roll back data. Additive migrations keep this safe.
- **Auto-revert**: if a new version fails completely (runtime does not start, or every invocation fails for several minutes after deploy), Hobwork restores the previous version automatically and records why, so the agent can see it.

Auto-revert details (`server/src/runtime/auto-revert.ts`):

- Only versions deployed by a merge are watched. Restores, including the auto-revert's own, are not, so a broken old version cannot start a loop.
- "Does not start": the VM does not boot, or the runner exits or does not answer within 60s. The runner imports every handler before it reports ready, so a handler that throws at import time counts.
- "Every invocation fails": within 1 hour of the deploy, no invocation succeeded, at least 5 failed, and the first and the latest failure are at least 3 minutes apart. One success ends the watch. The time span keeps a short outage of something a handler calls from reverting a good version; the count keeps a single failed cron from doing it.
- The target is version N-1, since versions on `main` are linear. The restore goes through the normal restore path with Hobwork as the author and the reason as the summary (`Auto-revert to version 4: version 5 did not start`). An `auto-revert` event in the project log says why. The merge that deployed the broken version reports the start failure and the pending revert in its result.

## Runtime

- Each deployed project has 0 or 1 runtime VMs. There is no scaling beyond 1. Concurrent invocations run in the same VM.
- The VM starts on the first invocation (HTTP request, cron tick, event) and stops after an idle timeout. Default 1 hour, configurable per project in `hobwork.json`. Cold start cost is the VM boot, roughly half a second.
- Inside the VM a Hobwork **runner** (Node) loads the deployed build and serves invocations from the host over the Gondolin ingress.
- The host owns scheduling and trigger subscriptions. A cron tick, webhook call or trigger wakes the VM if it is asleep.
- Deploy: start the new VM, wait until it is ready, switch traffic, drain and stop the old one.
- Handlers call back to the host (DB, logs, Home Assistant, devices, events) through the SDK over an internal endpoint that only the project's VMs can reach.

Implementation (`server/src/runtime/`):

- **What runs** is the newest version on `main`. The host reads its `hobwork.json` from git and keeps it in memory; after a host restart it reads it back from the versions table. On start the host registers the crons and HA triggers of every project's current version, including version 1 of a new project.
- **Build artifacts.** A build is the project's `dist/` after `pnpm run build`, stored at `data/builds/<project>/<tree>/`. The pipeline deletes its checkout after the run, so its build step copies `dist/` there first. Builds are keyed by git tree, not commit: a restore commits an old tree as a new commit and finds that version's build already there, so a restore does not build again. A version with no stored build (the template commit of a new project, or versions from before builds were kept) is built on deploy or first invocation in a fresh pipeline VM (install extras, `pnpm run build`, no tests). Only directories and regular files are copied, since the runtime VM mounts the build and a symlink written by project code could point at host files. Builds are limited to 256MB.
- **Old builds** (`server/src/runtime/build-cleanup.ts`) are deleted after every deploy and by the daily housekeeping job. A project keeps the builds of its newest 10 versions, of the versions its runtime VM runs or is starting, and any build less than an hour old (a pipeline stores its candidate's build before the merge records the version, and a restore may be building one). A restore of a version whose build was deleted builds it again, like a version from before builds were kept. The daily job also removes build directories of projects that no longer exist.
- **Handler bundles.** The template's `vite.config.ts` builds two Vite environments in one `vite build`: the dashboard (`index.html` at the project root with its code in `ui/`, built to `dist/index.html` and `dist/assets/`) and the handlers. Every handler in `hobwork.json` becomes `dist/handlers/<path without extension>.js`, an ES module with all dependencies bundled in (Node built-ins stay external), so the runtime VM needs no `node_modules`.
- **Runner delivery.** The runner is `packages/sdk/src/runner/` and uses only Node built-ins. The host mounts that directory read-only at `/opt/hobwork/runner` and runs `node /opt/hobwork/runner/main.ts`, with the build read-only at `/app`. The runner is host code, not SDK API: it speaks the host's invoke protocol, so it has to match the host version, and outside `node_modules` Node runs its TypeScript directly. Project code depends only on the context type from the SDK in the image, so context changes must stay additive for builds tested against an older SDK to keep working.
- **Protocol** (`packages/sdk/src/runner/protocol.ts`). The host POSTs `/invoke` on the runner's ingress with the invocation (ID, kind, name, manual), the handler path, the serialized request (method, URL, headers, base64 body), route params and payload. The runner answers with the serialized response or the error (name, message, stack). `GET /ready` answers once every handler module loaded. Console output inside an invocation (tracked with `AsyncLocalStorage`) and `ctx.log` lines are batched to `POST http://hobwork.internal/v1/logs` and flushed before the invocation answers. Output outside any invocation goes to the runner's stdout, which the host records as runtime logs.
- **VMs** get 512MB and 2 vCPUs, the project's `egress` plus the hosts of its secrets, the secrets as placeholders, and an internal handler bound to the project. A blocked egress request is logged as an `egress-blocked` event. Secrets are fixed when a VM starts, so an invocation that finds them changed starts a new VM and retires the old one.
- **Deploy** (the delivery `Deploy` hook): ensure the build, apply the version's new migrations to the project DB (a failure counts as "did not start" and triggers auto-revert), switch crons and HA triggers (`syncProjectTriggers`) to the new version, start the new VM and wait for `/ready`, switch, then retire the old VM: wait for its running invocations (up to the invocation timeout) and stop it. Without a runtime VM backend the bookkeeping still happens and invocations fail with an explanation.
- **Invocations** time out after 5 minutes on the host. Gondolin cannot signal the handler, so it may keep running until the VM stops. A runner that exits is logged as a `crash`, and the next invocation starts a new VM.
- **Routes** answer on two addresses. On the Hobwork host, `/p/<project>/api/*` takes only an agent token (`Authorization: Bearer`); the check is a `RouteAuthorizer` function in `server/src/runtime/http.ts`. Session cookies are not accepted there, since no page on the Hobwork origin calls project routes. On the project's app origin, `/api/*` takes only that origin's app session (see [Project app origins](#project-app-origins)). `authorization`, `cookie` and `proxy-authorization` headers are never passed to the handler. Request bodies are limited to 10MB.
- **Crons and HA triggers** of a branch never run on their own: the scheduler and HA subscriptions only use the deployed version. A branch's crons and triggers run through `invoke` with `branch`.
- **Webhooks** at `/hooks/<project>/<name>/<token>` accept any method. Tokens are 256 random bits, stored as SHA-256 hashes in `webhook_tokens`, and created or replaced with `rotate_webhook_token`, which shows the URL once. A webhook without a token cannot be called. Unknown project, webhook and token all answer 404. The handler sees the URL without the token.
- **Crons** use standard 5-field syntax, parsed by `server/src/runtime/cron.ts` rather than a dependency: numbers, ranges, lists, steps, month and weekday names, and Vixie cron's rule that a day matches either day field when both are restricted. Times are in the host's local time zone. A time skipped by a DST change does not run, a time that happens twice runs once, and ticks missed while the host is down are not caught up.
- **HA triggers** fire through the trigger registry's `invoke` hook as invocations of kind `trigger` with HA's trigger variables as `payload`. Refused or failing triggers, and HA connection losses that drop trigger events, are logged as `trigger` events in the affected projects' logs.

### Branch previews

A branch can be tried out before it is merged: its UI at its own app origin, its routes, and its crons, webhooks and triggers by hand. `server/src/runtime/runtime.ts` runs a preview like a deployed version, keyed by project and branch.

- **What runs**: the branch's latest commit in the bare repo, so only committed changes. Rejected: running the workspace checkout, which would show half-written files and need a build per request. Each request reads the branch head; a new commit makes the next request start a new VM and retire the old one, like a deploy. Previews have version `null`.
- **Build**: on first use, from that commit in a fresh pipeline VM (`createBuilder`, the same as for a version without a stored build). Builds are keyed by tree, so a branch that is merged unchanged reuses its build.
- **VM**: a separate runtime VM per branch with the same runner, resources (512MB, 2 vCPUs), egress and secrets as the deployed version, labelled `preview <project>/<branch>`. It stops after the branch's `idleTimeout`, at most 15 minutes. Rejected: a runner inside the workspace VM, which lives as long as agents run commands and has the registry in its egress allowlist.
- **Data**: the branch DB copy from [Branch and test DBs](#branch-and-test-dbs), with the preview commit's migrations applied the same way as for workspace queries. A workspace VM start copies production again, so preview data does not survive it.
- **Records**: invocations and log lines carry the branch (`invocations.branch`, `logs.branch`; `NULL` for the deployed version). Auto-revert never watches previews.
- **Cleanup**: deleting a project stops its preview VMs and closes their branch DBs. Build cleanup keeps the builds that preview VMs run or are starting with; a preview's build is never one of the kept versions, so it goes with the next cleanup after its VM stops (a preview VM stopping runs one).
- **App origin**: `<branch label>--<project>.<apps host>`, with its own app session (a session for main or another branch is rejected), through the same sign-in handoff as main with `branch` in `/auth/app`.
- **Branch labels** (`server/src/apps/origins.ts`): a whole host label is at most 63 characters of `a-z`, `0-9` and `-`. A branch that is already a lowercase label of at least three characters, with single hyphens, keeps its name (`add-spools--filament`). Any other branch (uppercase, `/`, `.`, `_`, two characters or fewer, which would put `--` at positions 3 and 4 like `xn--`, or too long) becomes a slug of its name plus the first 6 hex digits of its SHA-256 (`feature/Spools` becomes `feature-spools-3f9a1c`), so labels never collide. Labels never contain `--`, and project names cannot, so the last `--` splits the label. Project names are at most 40 characters, which leaves at least 21 for the branch. The host resolves a label by computing the labels of the project's branches (cached for 5 seconds).
- **Webhooks**: `/hooks/<branch label>--<project>/<name>/<token>`, with tokens per branch (`branch_webhook_tokens`), created with `rotate_webhook_token` and `branch`. Main's tokens do not work on a branch URL and the other way round.
- **Home Assistant**: see [Hobwork to HA](#hobwork-to-ha-actions).
- **Web UI**: the project page lists branches with their last commit, recent runs, a Preview page with the app in an iframe, and the Home Assistant switch. Activity has a filter for the live version and each branch, and the activity across projects names the branch of preview runs and events. `GET /api/projects/<name>/branches` returns this; `GET /api/projects/<name>/invocations?branch=<name>` filters (`main` for the live version).

### Internal endpoint

The SDK talks to the host at `http://hobwork.internal/` (HTTPS works too, through Gondolin's TLS interception). The hostname does not exist anywhere. Every sandbox is created with its own `internal` handler, and Gondolin's egress `onRequest` hook answers requests for `hobwork.internal` with that handler's `Response` before any DNS lookup, allowlist check or upstream connection.

- The handler is bound to the VM when it is created, so the host knows which project, version and workspace a call comes from without a token in the guest.
- Nothing else on the host is reachable. Host services on `127.0.0.1`, `10.0.2.2` and internal ranges are blocked by the egress policy, and no TCP port is forwarded.
- Secrets are substituted after `onRequest`, and none is bound to `hobwork.internal`, so the handler only ever sees placeholders.

Rejected: an allowed internal host (a real host port through `allowedInternalHosts`) would need auth tokens in the guest and exposes a real socket.

### Invocations and logs

Every invocation is recorded: ID, project, version, trigger (route, cron, event, manual), start, duration, result, error with stack trace. Console output from handlers is captured per invocation. Pipeline output and runtime lifecycle events (start, stop, crash, auto-revert) go to the same log store.

Agents read this through MCP (`list_invocations`, `get_logs`, `tail_logs`) and the `hobwork logs` CLI over SSH. Users see it on a project's Activity (invocations, filtered by kind, status and time, and each one with its error, stack trace and lines) and Log (all lines, only lifecycle events, or warnings and errors) pages. The top-level Activity page lists runs of every project with the same filters plus a project filter (`GET /api/activity`), and a Problems view (`GET /api/activity/problems`) that merges failed runs with lifecycle events at warn or error level: blocked requests, rollbacks, crashes, DB warnings, refused triggers and failed deploys, paged by time. The nav shows how many problems happened since the browser last showed that view (`GET /api/activity/attention?since=`, the time kept in `localStorage`, at most a week back). A partial index on `logs (time) WHERE event IS NOT NULL` keeps these queries off the full log. The log follows new lines with a long poll: `GET /api/projects/<name>/logs?after=<cursor>&wait=1` answers when a line arrives or after 25 seconds, and the page asks again. Rejected: server-sent events, which need the same wake-up and cursor plus reconnect handling, for no gain at a household's log volume.

Storage (`server/migrations/0004_runtime.sql`, `server/src/runtime/logs.ts`):

- `invocations`: kind (`route`, `webhook`, `cron`, `trigger`), name (route key or entry name), `manual`, status (`running`, `ok`, `error`), HTTP status for routes and webhooks, error and stack. Invocations still running at host start are marked failed.
- `logs`: one row per line with source (`handler`, `runtime`, `pipeline`), level, an optional invocation, and for lifecycle lines an event kind (`start`, `stop`, `crash`, `deploy`, `auto-revert`, `egress-blocked`, `trigger`, `pipeline`, `migration`, `db`). Pipeline runs log one line per step with up to 2,000 characters of its output; `pipeline_status` has all of it. Log line IDs are the cursor for `get_logs` and `tail_logs`.
- Bounds: messages are cut to 8,000 characters in the middle, an invocation keeps at most 1,000 lines (then one line saying the rest was dropped), and rows older than 30 days or beyond the newest 200,000 lines per project are pruned hourly. MCP output is cut at whole lines with a cursor to continue, and `tail_logs` waits at most 60 seconds.

## Data

- **Host DB**: SQLite for Hobwork's own state (users, agents, tokens, projects, versions, invocations, logs, pipeline runs, secrets).
- **Project DBs**: one SQLite file per project at `data/projects/<project>/db.sqlite`, owned by the host. Project code reaches it through the SDK, which sends queries to the host. VMs do not open DB files directly, because SQLite locking and WAL shared memory do not work reliably through the guest filesystem bridge across VMs.
- All SQLite databases use WAL, `busy_timeout`, `synchronous = NORMAL`, `foreign_keys = ON` and `STRICT` tables. Project DB connections also turn on SQLite's defensive mode.

### Query API

Handlers get `ctx.db` (`packages/sdk/src/index.ts`): `query(sql, params)` (rows), `get` (first row), `run` (`changes`, `lastInsertRowid`) and `batch(statements)`. Parameters are an array for `?` or an object for named placeholders. Values are null, numbers, strings, bigints, booleans (stored as 1 and 0) and `Uint8Array`. Blobs and bigints travel as `{ $blob }` and `{ $bigint }` in JSON.

- **Transport**: the runner POSTs `{ statements, transaction, invocation }` to `http://hobwork.internal/v1/db` (`DbRequest` in `packages/sdk/src/runner/protocol.ts`). The answer is the rows and change counts, or the SQLite error with the index of the failing statement (`DbError` in the handler).
- **Transactions**: there are no interactive transactions. A transaction held open across HTTP round trips would hold the project's write lock while handler code runs, and a handler that crashes or times out would leave it open. `batch` sends all its statements in one request, and the host runs them in one `BEGIN IMMEDIATE` transaction that rolls back on the first error. Read-then-write logic uses single statements (`UPDATE ... WHERE`, `INSERT ... ON CONFLICT`, `RETURNING`) or a batch.
- **Rules** (`packages/sdk/src/db/execute.ts`, enforced with SQLite's authorizer and a small lexer): one statement per SQL string (node:sqlite would silently ignore the rest); no schema changes, which belong in migrations so the dry run sees them; no `BEGIN` or `SAVEPOINT`; no `ATTACH`, `VACUUM` or `load_extension`, which could read or write files on the host; only introspection PRAGMAs (`table_info` and similar); no writes to `hobwork_migrations`. Results are limited to 10,000 rows.
- **Execution**: each open project DB has a worker thread with one connection (`server/src/data/db-pool.ts`), so a slow query blocks that project's queries and not the host. A query that runs longer than 30s is abandoned: SQLite cannot be interrupted from Node, so the worker is terminated and the next query opens a new connection. Workers close after 5 idle minutes.
- **Isolation**: the internal handler is bound to the VM when it is created, so a runtime VM reaches only its project's DB and a workspace VM only its branch DB.

### Migrations

- `migrations/NNNN_name.sql` in the repo, applied in version order, each in its own transaction, and recorded with a SHA-256 checksum in `hobwork_migrations` in the project DB. Forward-only: there are no down migrations. The host reads the files from git, never from a checkout, and refuses symlinks, so a migration cannot make the host read other files.
- **Deploy** applies the new migrations of the deployed version before it starts. A restore of an older version has fewer migrations, and nothing is undone.
- **Dry run** (the pipeline's `migrations` step, `server/src/data/project-data.ts`): all migrations are applied to an empty in-memory DB (what tests and new projects start from), then the new ones to a copy of the production DB. The production DB's worker writes the copy with `VACUUM INTO`, a consistent snapshot while handlers keep writing. node:sqlite's `backup()` was tried first and took seconds per copy under Vitest. The step fails with the SQL error, and also when:
  - an applied migration's file changed,
  - a new migration creates a table without `STRICT` (tables from earlier migrations are not checked again),
  - a table, view or column that existed before is gone afterwards.
- **Additive check**: comparing the schema before and after (tables and views with their columns, from `pragma_table_list` and `pragma_table_xinfo`) catches `DROP TABLE`, `DROP COLUMN` and both kinds of `RENAME` in any spelling. It still allows SQLite's usual way to change constraints: create a new table, copy the rows, drop the old table and rename the new one to the old name with the same columns. Rejected: matching `DROP` and `RENAME` in the SQL text, which cannot tell that rebuild apart from a real drop. Dropping indexes and triggers is allowed, since older versions still run without them.

### Branch and test DBs

- **Workspaces**: when a workspace VM starts, the host copies the production DB to `data/workspaces/<project>/<branch>/db.sqlite` (an empty DB if the project has none yet). Before each query from the VM, the branch's own `migrations/` that the copy has not seen are applied. If an applied one was edited, which is normal while developing, the branch DB starts over from a fresh production copy. The workspace VM reaches the branch DB at `hobwork.internal/v1/db`, and `hobwork sql "<statement>"` runs a statement on it.
- **Tests**: `@hobwork/sdk/testing` has `createTestDb()`, a fresh in-memory `node:sqlite` DB inside the VM with every migration from `migrations/` applied and the same executor and rules as the host, and `createTestContext()`, a handler context with one. Each call gives an empty DB, so tests are independent, and nothing crosses the VM boundary, so tests work the same in workspace and pipeline VMs. Rejected: an internal handler with a host-side empty DB for pipeline VMs, which would make tests share one DB and depend on the host.

### Warnings

- Statements slower than 500ms on a production DB are logged as `db` events (with the invocation, when the runner sent one), at most once per statement text every 10 minutes, and counted.
- DB size (file plus WAL) is checked at most once a minute after queries, and after migrations. Every time it crosses another 100 MB, a `db` warning is logged.
- `get_project` shows `database`: size, a size warning once over 100 MB, and the slow query count, slowest time and last slow statement since the host started.

## Backups

The host backs itself up to an S3-compatible bucket (AWS S3, Backblaze B2, Cloudflare R2, Hetzner Object Storage, MinIO) with [Kopia](https://kopia.io), daily at 03:30 local time by default (`server/src/backup/`).

- **What**: the host DB, every project DB, every project repo, `secret.key` and the SSH host key. Left out: builds (rebuilt on demand), workspaces (branches are in the repos; uncommitted workspace files are lost) and the Home Assistant and Pocket ID dev data.
- **Consistency while the host runs**: each run writes a copy into `data/backup-staging/`, laid out like a data dir. DBs are copied with `VACUUM INTO` from a worker thread, as for the migration dry run. Repos are copied with `git clone --mirror --no-local`, which goes through git's pack protocol and gets a consistent set of refs and objects while pushes and merges go on. Rejected: copying under the per-project merge lock, which does not cover pushes over HTTP and SSH. The project list comes from the copied host DB, so a project created during the run is left out whole. Kopia then snapshots the staging dir, which is deleted afterwards.
- **Incremental**: Kopia splits files into content-defined chunks (4 MB on average) and uploads only chunks the repository does not have yet, so an unchanged DB or repo costs nothing and a changed DB costs the chunks around the change. Compression is zstd.
- **Secret key**: included, since the encrypted values in the host DB are useless without it. The Kopia repository is encrypted with its own password (`HOBWORK_BACKUP_PASSWORD`), which must be kept outside Hobwork, e.g. in a password manager: without it nothing can be restored, and anyone with it and the bucket credentials can read every secret. With `HOBWORK_SECRET_KEY` there is no key file, so that key must be kept the same way.
- **Kopia**: the host runs the `kopia` binary (`HOBWORK_KOPIA_BIN`, default `kopia` on `PATH`). Tested with 0.17.0, the version on `hobwork-host` (`/usr/bin/kopia`, AUR `kopia-bin`); it uses no flags or JSON fields newer than that. Credentials and the password reach it through its environment (`KOPIA_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), never through arguments or logs. Its config, cache and logs are in `data/kopia/`. The first run connects to the repository, or creates it when the bucket prefix is empty, with `--no-persist-credentials` and the fixed identity `hobwork@hobwork`, so a host restored on another machine continues the same history. Kopia runs its own maintenance after snapshots.
- **Retention**: Kopia's global policy keeps 14 daily, 8 weekly and 12 monthly snapshots (`HOBWORK_BACKUP_KEEP_DAILY|WEEKLY|MONTHLY`), no hourly ones, and Kopia's defaults of the latest 10 and 3 annual ones. The policy is set again when the numbers change.
- **Runs**: the host's cron scheduler starts them (`HOBWORK_BACKUP_SCHEDULE`, a cron expression, `off` for manual backups only). A lock file (`data/backup.lock`) keeps the host and the CLI from running two at once. Each run is a row in `backup_runs` with its start, duration, snapshot ID, size, file count, uploaded bytes (how much the repository's blobs grew, since Kopia 0.17 does not report uploads) and error. Failures are logged as `BACKUP FAILED: ...`. Runs left as running by a stopped host are marked failed on start. Settings in the web UI shows the last backup, the next one, recent runs and a "Back up now" button (`GET|POST /api/backups`, users only).
- **Config**: backups are on when `HOBWORK_BACKUP_S3_BUCKET` is set, together with `HOBWORK_BACKUP_S3_ACCESS_KEY_ID`, `HOBWORK_BACKUP_S3_SECRET_ACCESS_KEY` and `HOBWORK_BACKUP_PASSWORD`. Optional: `HOBWORK_BACKUP_S3_ENDPOINT` (a host, or a URL where `http://` turns TLS off; default `s3.amazonaws.com`), `HOBWORK_BACKUP_S3_PREFIX` (default `hobwork/`), `HOBWORK_BACKUP_S3_REGION`.
- **Setting up on `hobwork-host`**: Kopia 0.17.0 is already installed. Create a bucket (and a key limited to it) at the S3 provider, put the `HOBWORK_BACKUP_*` settings into the systemd unit's environment (or a credential file), store the password in the password manager, and run `backup now` once to create the repository and check the settings.
- **CLI**: `pnpm --filter @hobwork/server backup now|list|verify [--percent <n>]|restore <empty-dir> [--snapshot <id>]`. `verify` runs `kopia snapshot verify`, which reads every snapshot's directories and a random share of the files (default 10 percent).
- **Restore**: on the new machine, with the same `HOBWORK_BACKUP_*` settings, run `pnpm --filter @hobwork/server backup restore <empty-dir>` (the newest snapshot, or `--snapshot <id>` from `backup list`). It connects with a throwaway Kopia config, restores into the dir and sets the key files to mode 0600. Then start the host with `HOBWORK_DATA_DIR` pointing there (and the old `HOBWORK_SECRET_KEY`, if one was used). On start the host reinstalls repo hooks; workspaces are cloned again when used and builds are rebuilt on the first invocation. By hand, the same is `kopia repository connect s3 ...`, `kopia snapshot list --all` and `kopia snapshot restore <id> <dir>`.
- **Tests**: unit tests use a fake `kopia`. `HOBWORK_BACKUP_TESTS=1` runs an integration test against MinIO with Kopia in Docker (`dev/backups/`): two backups with a change in between, where the second uploads a small fraction of the first, then a restore into an empty dir and a host started on it with its projects, DBs and secrets intact.

## Releases

The host ships as a tarball built by `.github/workflows/release.yml`. Pull requests, pushes to `main`, `v*` tags and manual runs all run install (frozen lockfile), typecheck, lint and test. Except on pull requests, it then packages the host on an x86_64 runner and attaches the tarball to a GitHub release for a tag, or keeps it as a workflow artifact for 30 days otherwise. `release/package.sh <version>` does the packaging and runs anywhere with git, Node and pnpm, but packages only for the architecture it runs on.

- **Contents**: `hobwork-<version>-linux-x86_64.tar.gz` (about 160MB, 560MB unpacked) holds one directory, `hobwork-<version>-linux-x86_64/`, laid out like the repo: the committed `server/` source and migrations, `packages/sdk`, `packages/theme`, `templates/project`, `images/platform`, the built `web/dist`, the x86_64 guest image at `images/build/x86_64` built from the same commit (it contains `packages/sdk`), production `node_modules` installed for linux-x64, and `VERSION` with the version and commit. A `.sha256` file sits next to it. The version is the tag without its `v`, or `<branch>-<short commit>` otherwise.
- **`node_modules`**: installed with `pnpm install --prod --filter @hobwork/server --filter @hobwork/theme` in the staged tree. `pnpm deploy` would give the server a standalone directory and break its relative imports of `packages/sdk` and `packages/theme`. pnpm's links are relative symlinks, so the tree works from any path; the script fails on an absolute one.
- **From the machine**: Node >= 24.12 (`hobwork-host` runs 26), `qemu-system-x86_64` and `qemu-img` 7.2 or newer (Gondolin 0.12 uses `-netdev stream`; `qemu-img` makes the copy-on-write root disks), git with `git http-backend` (part of git on Arch and Debian), Kopia 0.17 when backups are on, and read-write `/dev/kvm` for the service user.
- **Install and upgrade**: releases go to `/opt/hobwork/releases/`, with `/opt/hobwork/current` a symlink to the running one. The data dir lives elsewhere (`HOBWORK_DATA_DIR=/var/lib/hobwork`), since the default `data/` is inside the release.

  ```sh
  sha256sum -c hobwork-1.2.0-linux-x86_64.tar.gz.sha256
  sudo tar -xzf hobwork-1.2.0-linux-x86_64.tar.gz -C /opt/hobwork/releases
  sudo ln -sfn releases/hobwork-1.2.0-linux-x86_64 /opt/hobwork/current
  sudo systemctl restart hobwork
  ```

  The systemd unit runs `/usr/bin/node server/src/index.ts` with `WorkingDirectory=/opt/hobwork/current` and the `HOBWORK_*` settings in its environment. Host CLIs run the same way, e.g. `cd /opt/hobwork/current && HOBWORK_DATA_DIR=/var/lib/hobwork node server/src/cli/create-token.ts <name>` (the release has no pnpm). Rolling back is pointing `current` at the previous release. Host DB migrations are forward-only, so an older release then runs against a DB that newer migrations may have changed.
- **Private repo**: downloading a release needs a GitHub token with read access to the repo's contents, e.g. `gh release download v1.2.0 -R Barmore-Genc/hobwork` on a machine that is signed in to `gh`, then copying the files over.

## Secrets and network

- **Library and assignments**: there is one library of secrets. A secret has a name for people (`Spoolman API key`, unique ignoring case, at most 80 characters), a value, and the hosts it may be sent to. A project gets a secret only when it is assigned to it, and each assignment picks the env name the project sees (`SPOOLMAN_TOKEN` in one project, `API_KEY` in another). A project has at most one assignment per secret and one secret per env name. Env names are env var style and must not replace variables the guest relies on (`PATH`, `NODE_OPTIONS`, `HOBWORK_*` and similar). Host patterns follow Gondolin: `api.example.com` or `*.example.com`. `*` alone and `hobwork.internal` are refused.
- **Who does what**: only people create secrets and set their values and hosts (web UI or the host command). Agents can list the library and assign and unassign secrets over MCP, and nothing else. This split matters: an agent that could set hosts could assign any secret to a project and send its value anywhere, so hosts are chosen together with the value, by the person who has it. Assignments, and changes and deletions of assigned secrets, are logged as `secret` events in each affected project's log with who did it (user, agent, or the host command line).
- **Storage** (`server/src/secrets.ts`, `secrets` and `secret_assignments` tables): values are encrypted with AES-256-GCM, a random 96-bit IV per value, and `hobwork-secret:v2:<secret id>` as additional authenticated data, so a ciphertext copied to another row does not decrypt. The name is left out so a secret can be renamed without re-encrypting. `secrets` records the user who created and last changed it (null for the host command), `secret_assignments` the user or agent that assigned it.
- **Migration from project and global secrets** (0010): each old project secret becomes a library secret assigned to its project, and each global secret becomes one library secret assigned to every existing project that did not have its own secret of that name, so no project's secrets change on upgrade. Old names become both the library name and the env name. When several old secrets shared a name (a global one and project overrides, or several projects), the global one keeps it and project ones get the project appended (`SHARED (filament)`); old names are env var style, so this cannot clash. The migration is SQL and has no key, so it keeps each ciphertext and stores its old additional data in `legacy_aad`. When the host opens the store with the key, it re-encrypts those values with the new additional data and clears the column. A value that does not decrypt (wrong key) is left as it was and fails when a VM needs it, as before.
- **Key**: `HOBWORK_SECRET_KEY` (32 bytes as hex or base64) when set. Otherwise `data/secret.key`, generated on first start with mode 0600. The host refuses to start when the file is readable by other users. The file protects against a leaked copy of `hobwork.db` alone. Hobwork's own backups include it, inside the encrypted Kopia repository (see [Backups](#backups)). The env var, e.g. from a systemd credential, keeps the key out of backups. With a different key, existing secrets do not decrypt and VM starts fail with that message instead of using wrong values.
- **In VMs**: the host decrypts values only to hand them to the `Sandbox`'s `secrets` option, keyed by env name. The guest sees `GONDOLIN_SECRET_...` placeholders in env vars of the assigned env names, and the runner gives handlers `ctx.secrets` (env name to placeholder). Gondolin replaces a placeholder with the value in request headers to the bound hosts only, after the internal handler ran, so neither handler code nor the host's internal endpoint sees values. Substitution in URLs and bodies is off.
- **APIs**: no API or MCP tool returns values. MCP: `list_secrets` (the library with each secret's hosts and assignments, or with `project` the project's env names), `assign_secret(project, secret, env_name)` and `unassign_secret(project, env_name)`; no tool takes a value or hosts. `get_project` lists the env names. The web API in `server/src/api/routes.ts` needs a signed-in user and the CSRF header, so agent and OAuth tokens get 401 on every secret endpoint, assignments included (agents assign only over MCP): `GET /api/secrets` (the library with assignments), `POST /api/secrets` with `{ name, value, hosts, assign?: { project, envName } }` (create, optionally assigning in the same step), `PATCH /api/secrets/<id>` with `{ name?, value?, hosts? }`, `DELETE /api/secrets/<id>` (also unassigns it everywhere), `GET /api/projects/<name>/secrets` (the project's secrets by env name), `PUT /api/projects/<name>/secrets/<ENV_NAME>` with `{ secretId }` (assign) and `DELETE` on the same path (unassign). On the host, `pnpm --filter @hobwork/server secret list|create|update|delete|assign|unassign` does the same from a shell and reads values from stdin.
- **UI**: the Secrets page lists the library with the projects each secret is assigned to, and creates, changes, deletes (the confirmation names the projects that use it) and assigns secrets. A project's Secrets tab lists its secrets by env name with who added them and when, assigns an existing secret or creates and assigns a new one, and removes them.
- **Egress**: a runtime VM may reach the `hobwork.json` `egress` hosts and the hosts of the secrets assigned to the project. Workspace VMs get the same plus `registry.npmjs.org`, pipeline VMs only the registry. Blocked requests get a 403 and an `egress-blocked` line in the project log with the host and port, so an agent can see why a fetch failed. Changes to `hobwork.json` show up in the version diff in the UI.
- Secret changes apply without a restart: runtime and workspace VMs compare a fingerprint of the project's assigned secrets (secret IDs, env names, hosts, update times) and are replaced on the next invocation or `bash` call, so assigning, unassigning, changing or deleting a secret reaches running VMs and their egress allowlist.

## Dashboards and UI

- Project UIs are plain React + Tailwind pages: `index.html` at the project root with the code in `ui/`, built by the pipeline with Vite to `dist/index.html` and `dist/assets/`, and served by the host from the deployed version's build at the root of the project's own origin (`server/src/apps/`, `server/src/runtime/project-ui.ts`). A version without a stored build is built on the first request, as for invocations.
- Serving: only a signed-in user's app session for that origin (see [Project app origins](#project-app-origins)). A path serves the file from the build if there is one, except `dist/handlers/`, and `index.html` for paths without an extension, so client-side routes work. The host adds `<base href="/">` to `index.html` (unless it has one), so relative URLs from older builds (`./assets/...`) resolve on any client-side route; the template builds with `base: '/'`. Files under `assets/` are cached as immutable (Vite hashes their names), `index.html` is revalidated. The host also serves the theme (`/theme/...`) on app origins. Old links to `/p/<project>/<path>` on the Hobwork host redirect to the app origin.

### Project app origins

Project UIs run agent-written JavaScript. On the Hobwork origin that code would run with the user's session and could call Hobwork's API as the user, for example to change which hosts a secret may be sent to. So every project UI has its own origin, with its own session that grants nothing but that project's UI and routes.

- **Origins**: `HOBWORK_APPS_URL` (default: `apps.` in front of the host of `HOBWORK_PUBLIC_URL`, same scheme and port) names the apps host. A project's app is at `<scheme>://<project>.<apps host>`, a branch preview at `<branch label>--<project>.<apps host>` (see [Branch previews](#branch-previews)). Both are a single DNS label below the apps host, so one wildcard DNS record and one wildcard certificate cover every project and branch. The host tells app requests apart by the `Host` header: a host name one label below the apps host is an app origin, anything else is Hobwork (`server/src/apps/origins.ts`).
- **Same site**: the Hobwork web UI shows the app in an iframe. Browsers only send SameSite=Lax cookies to a framed page, and through the sign-in redirects inside it, when the frame is the same site as the page around it: same scheme and registrable domain. `hobwork.example.com` and `filament.apps.hobwork.example.com` (or `filament.apps.example.com`) are the same site; a different registrable domain would make app cookies third-party cookies, which browsers increasingly block. In development, `hobwork.localhost` and `filament.apps.hobwork.localhost` are the same site in Chromium, while plain `localhost` and `filament.apps.localhost` are not (checked with Playwright: `Sec-Fetch-Site` and cookies in the iframe), so the dev setup uses `http://hobwork.localhost:<port>` and the host warns when `HOBWORK_PUBLIC_URL` is on `localhost`.
- **Sign-in handoff** (`server/src/apps/http.ts`):
  1. A request to an app origin without its app session: a page load (`GET` accepting HTML) is redirected to `<HOBWORK_PUBLIC_URL>/auth/app?project=<name>[&branch=<branch>]&returnTo=<full app URL>`; other requests get 401.
  2. `/auth/app` checks that `returnTo` is on exactly the app origin of that project and branch (scheme, host and port) and not under `/_hobwork/`, and answers 400 otherwise. Without a Hobwork session it sends the browser to `/login?returnTo=/auth/app?...`; the Pocket ID flow (`/auth/login` keeps `returnTo` in its flow cookie) and the passkey flow (the web UI reloads `returnTo` when it is under `/auth/`) both come back to it.
  3. With a session, it creates a code (256 bits, stored as a SHA-256 hash in `app_codes`, 60 seconds, single use, bound to the Hobwork session, project and branch) and redirects to `<app origin>/_hobwork/callback?code=...&returnTo=<path and query>`.
  4. The app origin exchanges the code on the server. It deletes the code in the same statement that reads it, so a code works once even when used on the wrong origin, and turns it into an app session: a random token stored as a hash in `app_sessions` with the Hobwork session's ID, project and branch. The cookie (`hobwork_app`, `__Host-hobwork_app` on https) is HttpOnly, SameSite=Lax, host-only and lasts as long as the Hobwork session. `returnTo` is checked again (a path on the same origin, not `//` or `/\`); anything else goes to `/`.
- **What an app session can do**: load that origin's UI and call its routes, nothing else. It is looked up by token together with the project and branch of the origin it arrives on, so another project's origin, a branch preview and Hobwork's own API (which only reads `hobwork_session`) reject it. The `__Host-` prefix on https keeps a sibling app from planting a cookie for another app with a `Domain` attribute; each app's cookie is host-only, so no other origin receives it.
- **Sign-out**: app sessions reference the Hobwork session with `ON DELETE CASCADE`, so signing out of Hobwork (or the session expiring) ends every app session made from it. The allowlist is checked on every request, like for Hobwork sessions.
- **CSRF**: sibling apps are same-site, so their requests carry SameSite=Lax cookies. Route writes on an app origin need `x-hobwork-csrf: 1` (which a cross-origin page cannot send without a CORS preflight, which is never allowed), and `Origin` and `Sec-Fetch-Site`, when present, must be the app origin itself and `same-origin`. The Hobwork web UI answers with `frame-ancestors 'self'`, so apps cannot frame it either.
- **Framing**: every response from an app origin carries `Content-Security-Policy: frame-ancestors <HOBWORK_PUBLIC_URL>`. The Apple apps load the app origin in a WebView as a top-level page.
- **Production setup**: a wildcard DNS record `*.apps.hobwork.example.com` pointing at the reverse proxy, a wildcard certificate for it (Let's Encrypt issues those only with the DNS-01 challenge, which Caddy and Traefik do with a DNS provider plugin), and the proxy forwarding those hosts to Hobwork with the original `Host` header. Hobwork itself stays at `hobwork.example.com`, and `HOBWORK_APPS_URL=https://apps.hobwork.example.com` (the default for that public URL). Use https: the `__Host-` cookie prefixes depend on it.
- Rejected: one origin per project on the same host with different ports (cookies ignore ports, so every app would receive every other app's cookies); paths on the Hobwork origin with a sandboxed iframe (`sandbox` without `allow-same-origin` gives the page an opaque origin, so it cannot keep a cookie of its own, and opening the app in its own tab would lose the sandbox).

- The host provides one theme stylesheet with CSS variables (colors, radii, fonts, light/dark). The template's Tailwind setup maps these to utility classes (`bg-surface`, `text-muted`, ...). Anything that uses them stays on theme, including third-party components.
- The theme lives in `packages/theme/` (`@hobwork/theme`), which the image build copies into the platform set next to the SDK, so project builds import `@hobwork/theme/tailwind.css` like the web UI does and the mapping is versioned with the image. The template's `index.html` loads `/theme/theme.css` from the host (marked `vite-ignore`, so Vite leaves the URL alone), and `ui/index.css` imports Tailwind and the mapping. The host serves `theme.css` at `/theme/theme.css` and its fonts (Bricolage Grotesque for headings, Atkinson Hyperlegible Next for text, from the fontsource packages) at `/theme/fonts/`. `tailwind.css` is the Tailwind v4 `@theme inline` mapping, so utilities read the variables and follow light/dark without `dark:` variants. Pages follow the system setting unless the root element has `data-theme="light"` or `"dark"`.
- Variables: colors `--hw-bg`, `--hw-surface`, `--hw-surface-raised`, `--hw-border`, `--hw-fg`, `--hw-muted`, `--hw-accent` (fills), `--hw-accent-fg` (accent text), `--hw-on-accent`, `--hw-success`, `--hw-warning`, `--hw-danger`, `--hw-on-danger`, `--hw-focus`; radii `--hw-radius-sm|md|lg`; fonts `--hw-font-sans|display|mono`. Utilities drop the prefix: `bg-surface`, `text-muted`, `text-accent-fg`, `border-border`, `rounded-md`, `font-display`.
- The Hobwork web UI (`web/`) uses the same stylesheet and mapping. The host serves the built UI (`web/dist`) for every path the other handlers (API, auth, git, MCP, project routes, webhooks, theme) do not take, with `index.html` as the fallback for client-side routes. In development the Vite server proxies `/api`, `/auth` and `/theme` to the host, and project apps are opened on the host's own port.
- No component library in core. Projects can add any npm package. Shared components can be added later if agents keep rewriting the same ones.
- `@hobwork/sdk/browser` is the browser client for the project's own routes: `api.get|post|put|patch|delete(path, body?)` requests `/api/<path>` on the app origin with the app session and the CSRF header, parses JSON and throws a `RouteError` with the handler's error message; `callRoute` is the same as a plain `fetch`.
- The Hobwork web UI shows a project's UI in an iframe of its app origin on the project's app page ("Open app", shown when the deployed build has `index.html` or is not built yet), with a link to open it in its own tab. `GET /api/projects/<name>` returns the origin as `appUrl`. The iframe signs in through the same redirects, which need no user action while the Hobwork session exists. The Apple apps will use a WebView.

## Users and authentication

- **Users**: a small fixed set (the household). Login with OIDC (pocket-id) and passkeys (WebAuthn), so the project works for other people who do not run pocket-id.
- **Who may sign in**: `HOBWORK_ALLOWED_USERS`, a comma-separated list of email addresses and `sub:<subject>` entries. An email only matches when the provider marks it verified. There is no first-user bootstrap: an open window where the first person to sign in becomes a user is a risk when the IdP serves more people than the household, and the allowlist is one line of config. The first sign-in of an allowed identity creates the user. The allowlist is checked on every request, so removing someone signs them out. `*` instead of a list lets in everyone the provider signs in, for a provider that already limits who can use Hobwork (a Pocket ID client restricted to a group); it cannot be combined with entries. An empty or unset allowlist still lets nobody in, so a missing setting never opens the host.
- **OIDC**: authorization code flow with PKCE (S256), state and nonce, through `openid-client` against `HOBWORK_OIDC_ISSUER` with `HOBWORK_OIDC_CLIENT_ID` and `HOBWORK_OIDC_CLIENT_SECRET` (client_secret_basic; without a secret the client is public). The redirect URI is `<HOBWORK_PUBLIC_URL>/auth/callback`. The login state lives in a 10 minute HttpOnly cookie on `/auth/`. Users and their identities are separate tables (`users`, `user_identities`). A new identity whose verified email matches an existing user joins that user.
- **Sessions**: random 256-bit tokens, stored as SHA-256 hashes in the host DB, valid 30 days. The cookie is HttpOnly, SameSite=Lax, and `__Host-` prefixed and Secure when `HOBWORK_PUBLIC_URL` is https.
- **CSRF**: state-changing requests with a session cookie must send `x-hobwork-csrf: 1` (a cross-site page cannot set it without a CORS preflight, which the host never allows), and their `Origin` and `Sec-Fetch-Site`, when present, must be the public origin and same-origin. Code that serves other routes uses `requireUser` (writes the 401/403) or `sessionUser` from `server/src/auth/auth.ts`, which do both checks. Project routes on the Hobwork host take only agent tokens; project UIs call them on their own origin with an app session and the same CSRF rules, checked against the app origin (see [Project app origins](#project-app-origins)). Cookies never reach the handler.
- **Project status** in the UI: `updating` while a pipeline run is in progress, `running` while the runtime VM is up, otherwise `ready` (starts on demand). The current version is the deployed one from the runtime, which can lag behind the newest version while a deploy runs or after it failed.
- **Passkeys**: WebAuthn through `@simplewebauthn/server` and `@simplewebauthn/browser`. The RP ID is the host name of `HOBWORK_PUBLIC_URL` and the expected origin is `HOBWORK_PUBLIC_URL`. Credentials are discoverable (resident key required) with user verification required, so sign-in needs no user name. They live in `passkeys`, attached to `users`, with a random WebAuthn user handle per user (`users.webauthn_id`). Challenges are stored in the host DB (`webauthn_challenges`, 5 minutes, used once) and referenced by a `flowId`. Endpoints: `POST /auth/passkey/options` and `POST /auth/passkey` (signed out, CSRF header required), `GET /api/passkeys`, `POST /api/passkeys/options`, `POST /api/passkeys`, `DELETE /api/passkeys/<id>`. The allowlist still decides: a passkey only signs in a user who is allowed.
- **Bootstrap without an identity provider**: only a signed-in user can add a passkey, so there is no open enrollment. For someone without pocket-id, the host operator runs `pnpm --filter @hobwork/server sign-in-link <email> [--name <name>]`. The email must be on `HOBWORK_ALLOWED_USERS`; the command finds or creates the user with that email and prints a one-time link (`/auth/link?token=...`, 15 minutes, hashed in `sign_in_links`) that signs them in and opens Settings to add a passkey. Running the command vouches for the email, like the provider does for OIDC.
- **Web UI API** (all need a session): `GET /api/session` (also works signed out, lists sign-in methods), `GET /api/projects`, `GET /api/projects/<name>` (versions; the deployed version's entry points with next cron runs, webhook token dates and each entry point's last invocation; reachable hosts; DB status; whether it has a UI), `POST /api/projects/<name>/versions/<n>/restore`, `GET /api/projects/<name>/invocations` (`kind`, `status`, `since`, `before`, `branch`, `limit`; newest first with `more`), `GET /api/projects/<name>/branches` and `PUT|DELETE /api/projects/<name>/branches/<branch>/home-assistant` (see [Branch previews](#branch-previews)), `GET /api/projects/<name>/invocations/<id>` (with stack and log lines), `GET /api/projects/<name>/logs` (`view=all|events|problems`, `after`, `wait=1`, `limit`), `POST /api/projects/<name>/webhooks/<webhook>/token` (a new URL, shown once), `DELETE /api/projects/<name>` (see [Deleting projects](#deleting-projects)), `GET /api/activity`, `GET /api/activity/problems` and `GET /api/activity/attention` (across projects), `GET|PUT|DELETE /api/settings/homeassistant` and `POST /api/settings/homeassistant/test` (see [Home Assistant](#home-assistant)), the device endpoints under [Host implementation](#host-implementation), the secrets endpoints under [Secrets and network](#secrets-and-network), `GET|POST /api/agents`, `POST /api/agents/<id>/tokens`, `POST /api/tokens/<id>/revoke`, `POST /api/agents/<id>/ssh-keys`, `POST /api/ssh-keys/<id>/revoke`, `POST /api/connections/<id>/revoke` (an OAuth connection), `GET /api/oauth/requests/<id>` and `POST .../approve|deny` (the consent page). Restores by a user are recorded with the user (`versions.user_id`) and use their name and email as the git author.
- **Agents**: separate identities, not tied to a user. Users create and revoke agent access in the UI.
- **MCP auth**: Hobwork is the OAuth 2.1 authorization server for its own MCP endpoint, following the MCP authorization spec revision 2026-07-28, which claude.ai, Claude Desktop, Cowork and Claude Code custom connectors use. Static agent tokens keep working next to it.
  - Discovery: a 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="<public URL>/.well-known/oauth-protected-resource/mcp"` (also served without the `/mcp` suffix). Protected resource metadata (RFC 9728) names the resource `<HOBWORK_PUBLIC_URL>/mcp` and the issuer `<HOBWORK_PUBLIC_URL>`, whose metadata (RFC 8414) is at `/.well-known/oauth-authorization-server`. MCP clients must use the `/mcp` URL under `HOBWORK_PUBLIC_URL`, since the resource has to match. There are no scopes: a connection can do everything an agent can.
  - Clients: Client ID Metadata Documents (the spec's preferred way, `client_id_metadata_document_supported`) and dynamic client registration (RFC 7591, deprecated in the spec but still the fallback of many clients) at `/oauth/register`. A client ID that is an https URL with a path is fetched on demand (https only, public addresses only, checked at connect time, no redirects, 16 KiB, 5 seconds) and cached for its `max-age`, between 1 minute and 1 day. Claude uses `https://claude.ai/oauth/mcp-oauth-client-metadata` and Claude Code `https://claude.ai/oauth/claude-code-client-metadata`. Registered clients live in `oauth_clients`; ones never approved are deleted after a day. Public clients (`none`) and `client_secret_basic`/`client_secret_post` are supported. Redirect URIs must be https or http on localhost/127.0.0.1/[::1] and match exactly, except that loopback ones match on any port (RFC 8252), which Claude Code needs.
  - Flow: `/oauth/authorize` takes the authorization code flow with PKCE S256 only and an optional `resource` (RFC 8707) that must be the MCP resource. Errors before the client and redirect URI are validated go to the web UI (`/connect?error=...`), never to the redirect URI. A valid request is stored (`oauth_requests`, 15 minutes) and the browser goes to the consent page `/connect?request=<id>`, which needs a signed-in user like every page. The page shows the app name, its domain for metadata document clients (or a warning that the app is unverified), what it can do, the redirect host, and a warning for loopback redirects. Approving creates an agent named after the client (with a number added when the name is taken; the user can rename it) and a grant (`oauth_grants`), and redirects with a code (5 minutes, single use) plus `state` and `iss` (RFC 9207).
  - Tokens: `/oauth/token` exchanges the code (checking PKCE, redirect URI, client and resource) and refreshes. Access tokens (`hwa_...`) last 1 hour; refresh tokens (`hwr_...`) last 30 days and rotate on every use, so a connection in regular use stays connected. Reusing a rotated refresh token or a used code revokes the whole grant. Tokens are 256 random bits stored as SHA-256 hashes (`oauth_tokens`). `/oauth/revoke` (RFC 7009) revokes an access token, or a refresh token together with its grant. MCP accepts an access token only for the resource it was issued for.
  - Agents that connected this way show their connections on the Agent access page, where revoking one ends its tokens. Agents stay; they can also hold static keys and SSH keys.
- **git HTTP**: agent token as the password.
- **SSH**: public keys registered to an agent (see [SSH gateway](#ssh-gateway)).
- Agents can do everything on projects except delete them, manage users and agents, change the Home Assistant connection, pair, remove or notify devices (deployed handlers notify them), and create secrets or set their values and hosts (they can assign existing secrets to projects).

## Devices (Apple apps)

- The app keeps a WebSocket to the host and registers the device and its capabilities.
- Scripts call capabilities through the SDK: `ctx.device("kaan-iphone").notifications.send(...)`.
- If a capability needs the app in the foreground (NFC), the host sends a push notification. Tapping it opens the app straight into the action.
- NFC tags written by Hobwork contain a URL that opens the app (universal link), not the browser.

### Device protocol

- **Discovery**: the app asks for the host URL in a native view and checks it with `GET /.well-known/hobwork` (no auth), which answers `{ "hobwork": 1, "name": <host name of the public URL>, "version": <host version> }`.
- **Pairing**: the app opens `ASWebAuthenticationSession` at `<public URL>/devices/connect?name=<device name>&platform=ios|macos&challenge=<PKCE S256, base64url, 43 characters>&state=<random>&redirect_uri=hobwork://paired`. `redirect_uri` must be exactly `hobwork://paired`; `state` is optional and at most 512 characters. The page needs a signed-in person like every page (so Pocket ID or a passkey happens inside the session), shows the device name, suggests the name projects use for it (a slug: `Kaan's iPhone` becomes `kaans-iphone`, which the person can change) and asks to approve. Approving redirects to `hobwork://paired?code=<code>&state=<state>` (code: 5 minutes, single use; a wrong verifier also uses it up). Cancelling redirects to `hobwork://paired?error=access_denied&state=<state>`. The app sends `POST /api/devices/token` with JSON `{ code, codeVerifier }` (`code_verifier` works too) and gets `{ deviceId: number, name, token }`; errors answer 400 `{ error }`. The exchange creates the device, owned by the person who approved; if another device took the name in between, the new one gets a number (`kaans-iphone-2`). The device token (`hwd_...`, stored hashed) does not expire; people remove devices in the web UI, and the app removes its own device when someone signs out in it (`DELETE /api/devices/self`, Bearer device token, 204), which works exactly like removing it in the web UI: the web view's session and its app sessions end, the push token is forgotten and the socket closes with 4001. The app keeps the token in the Keychain. Every device endpoint, the WebSocket upgrade included, answers 401 for a removed or unknown token, which the app takes as unpaired, and 403 `{ "error": "not_allowed" }` for a device whose owner is no longer on `HOBWORK_ALLOWED_USERS`: the app keeps its token, since it works again once the owner is added back, and retries slowly.
- **Web session in the app**: device tokens never go to the WebView. The app calls `POST /api/devices/web-session` (Bearer device token) with JSON `{ returnTo }` (a path on the Hobwork origin, default `/`; anything else answers 400) and gets `{ url }`: a one-time `<public URL>/auth/device?token=...` (60 seconds, single use) that sets a normal Hobwork session cookie for the device's owner and redirects to `returnTo`. A used or expired link redirects to `/login?error=link_expired`. The app loads that URL in its `WKWebView` (persistent data store) directly with `load(URLRequest)`, which then signs in to project apps through the usual app-origin redirects (for example `returnTo=/auth/app?project=filament&returnTo=...`). The link answers 403 unless `Sec-Fetch-Site` is `none` (what WebKit sends for a load the app starts) or missing, so a page cannot sign the web view in to someone else's account by linking there (login CSRF); a link followed from a page, JavaScript navigation included, does not work. The session belongs to the device (`sessions.device_id`): each new sign-in replaces the previous one, and removing the device ends it and every app session made from it.
- **Connection**: `GET /api/devices/ws` upgraded to a WebSocket, `Authorization: Bearer hwd_...` (401 or 403 before the upgrade otherwise, as for the HTTP endpoints). Messages are JSON text frames, objects with a `type`; the host ignores types it does not know:
  - app → host `hello`: `{ appVersion, platform, capabilities: string[], push?: { token, environment: "sandbox" | "production" } }`. Sent on every connect, and first: the host sends no calls before it and closes a connection without one after 30 seconds. `push.token` is the APNs device token in hex; `push: null` turns push off. The push token can also be updated with `PUT /api/devices/push` (`{ token, environment }` or `{ token: null }`, 204) while disconnected. The platform is fixed at pairing.
  - host → app `call`: `{ id, capability, method, args }`; app → host `result`: `{ id, ok: true, value }` or `{ id, ok: false, error: { code, message } }`. The host waits 15 seconds for a result.
  - app → host `event`: `{ capability, name, data }` (for example a notification action). The same object without `type` can be sent with `POST /api/devices/events` (Bearer device token, 204), for when iOS wakes the app in the background to handle an action and a socket would take too long.
  - Both sides send `{ "type": "ping" }` every 30 seconds and answer `{ "type": "pong" }`. The host counts any message as a sign of life and closes a connection that stays silent through two of its pings.
  - A device that connects again replaces its old connection. Close codes: 4000 replaced by a newer connection, 4001 the device was removed, 4002 protocol error (no hello, a message that is not a JSON object), 4003 no answer to two pings, 4004 the owner was taken off `HOBWORK_ALLOWED_USERS` (checked at every ping; the device token works again if they are added back), 1001 host shutting down.
- **Push**: APNs with a token (`.p8`) key: `HOBWORK_APNS_KEY_FILE`, `HOBWORK_APNS_KEY_ID`, `HOBWORK_APNS_TEAM_ID`, topic `dev.bgenc.hobwork`, to `api.sandbox.push.apple.com` or `api.push.apple.com` by the environment the app reported. Without them push is off and notifications only reach connected devices. A token APNs reports as gone (410, `BadDeviceToken`, `DeviceTokenNotForTopic`) is forgotten until the app sends a new one. A push token belongs to one device: registering it (`hello` or `PUT /api/devices/push`) takes it off any other device, such as an earlier pairing of the same phone, and removing a device forgets its token.
- **SDK**: `ctx.device(name)` returns the capabilities; `ctx.devices()` lists devices (`name`, `platform`, `owner`, `capabilities`, `connected`, `lastSeenAt`). Devices whose owner is no longer on `HOBWORK_ALLOWED_USERS` are left out, get nothing, and lose their socket; the web UI still lists them, so people can remove them. Deployed handlers use devices. Workspaces and branch previews list them, but their calls answer `read_only`, since code there is work in progress and a stray notification reaches a real person. Tests fake them with `createTestContext({ device: (name) => ({ notifications: { send } }) })`. Agents see devices with the `list_devices` MCP tool; they cannot pair, remove or notify devices.

#### Notifications

- **Sending**: `ctx.device(name).notifications.send({ title, body?, actions?: [{ id, title }], data? })` returns `{ id, delivery: "app" | "push" }`. The title is at most 200 bytes and the body at most 2,000 bytes as UTF-8, with up to 4 actions with IDs of letters, digits, `-` and `_` and titles of at most 64 characters; `data` is up to 4 KB of JSON that comes back with an action and is never sent to the device. The push payload is then measured, since JSON escaping can grow it past APNs' 4,096 bytes, so every notification that is accepted can go by push. Failures throw a `DeviceError` with a code: `unknown_device`, `unsupported` (the app never reported `notifications`), `unreachable` (not connected and no push), `too_large` (the push payload would be over 4,096 bytes; nothing is sent), `push_failed` (APNs refused it or could not be reached), `bad_request`, `read_only`, or the app's own code. Calls are logged with the invocation.
- **Over the socket** when the device is connected: `call` with capability `notifications`, method `send` and args `{ id, project, title, body?, actions }`. The app shows it with `id` as the request identifier and answers `ok: true` (the value is ignored), or an error (for example `not_authorized` when notifications are off), which fails the send. A timeout or a dropped connection falls back to push.
- **By push** otherwise: `apns-push-type: alert`, priority 10, `apns-id` and `apns-collapse-id` set to the notification ID (so a notification that reached the app both ways shows once), expiring after a day. Payload: `{ aps: { alert: { title, body }, sound: "default", "thread-id": <project> }, hobwork: { id, project, actions } }`; the title and body are only in `aps.alert`. With actions, `aps` also has `category: "hobwork.<id>"` and `mutable-content: 1`: actions differ per notification, so the app's notification service extension registers that category from `hobwork.actions` before iOS shows it.
- **Actions**: a tap sends `event` `{ capability: "notifications", name: "action", data: { id, action } }`. The host checks that the notification went to that device and had that action, and runs each trigger of the project that sent it declared as `{ "device": { "capability": "notifications", "event": "action" }, "handler": ... }` in `hobwork.json`, with `ctx.payload` `{ device, capability: "notifications", event: "action", notificationId, action, data? }` (`NotificationActionEvent`). Each notification answers once, when its triggers start; repeats after that are ignored. A tap on a project without such a trigger (or whose triggers cannot be read) is logged as a `trigger` warning in its log and leaves the notification unanswered, so the app sending the event again runs the trigger once the project has one. Notifications are kept 30 days (`device_notifications`).

#### Host implementation

`server/src/devices/`: `store.ts` (tables from `server/migrations/0016_devices.sql`: `devices`, `device_pairing_codes`, `device_sign_in_links`, `device_notifications`), `registry.ts` (one connection per device, calls matched to results by ID with timeouts; a result is only accepted from the connection the call went to), `socket.ts` (the WebSocket, on the `ws` package), `devices.ts` (sending notifications and handling events), `apns.ts` (HTTP/2 with `node:http2`, one connection per APNs origin, closed after 5 idle minutes because NAT gateways drop idle connections silently; a request without an answer in 10 seconds drops its connection and is sent once more on a new one; ES256 provider tokens signed with `node:crypto` and renewed every 40 minutes or when APNs answers `ExpiredProviderToken`), `routes.ts`, and `internal.ts` (`POST http://hobwork.internal/v1/devices` for runtime and workspace VMs). The web UI lists devices under Settings, Devices (`GET /api/devices`, `PATCH /api/devices/<id>` to rename, `POST /api/devices/<id>/revoke`, which also closes the device's socket and ends its web view's session) and has the pairing page (`GET /api/devices/pairing?<the query of /devices/connect>`, `POST /api/devices/pairing/approve` with `{ request, name }`, `POST /api/devices/pairing/deny` with `{ request }`).

Planned capabilities:

- **NFC** read and write (Core NFC, foreground only, system scan sheet).
- **Alarms** (AlarmKit, iOS 26+).
- **Screen Time**: block apps and set limits (Family Controls, Managed Settings, Device Activity). The development entitlement works for our own devices through Xcode builds. TestFlight and App Store need Apple to approve the distribution entitlement. macOS support is still to be checked.
- **HealthKit** (possible): read sleep data directly, instead of going through a Health export API.

## Home Assistant

The host keeps one WebSocket connection to HA, authenticated with a long-lived access token. The connection is pinged, and reconnects with exponential backoff (1s up to 60s) when it drops.

Connection settings (`server/src/homeassistant/settings.ts`, `homeassistant_settings` table):

- People set the URL and token in the web UI (Settings, Home Assistant), which shows the connection status, HA version and the last error, and has "Test connection" (a separate connection that signs in and closes, nothing saved) and "Disconnect" (forgets the token). Agents have no tool or API for any of it.
- The token is write-only: no response contains it. It is encrypted with AES-256-GCM using the secrets key (see [Secrets and network](#secrets-and-network)) with its own additional data. Keeping the saved token while changing the URL is refused, and a test only uses the saved token for the saved URL, so the token is never sent to an address someone typed in without also typing the token.
- Precedence: `HOBWORK_HA_URL` and `HOBWORK_HA_TOKEN`, when set, win over the saved setting, and the settings page shows the connection as set in the server configuration and cannot change it. The host operator's configuration is the explicit choice, and a page that looked editable but did nothing would mislead.
- Saving or disconnecting calls the client's `reload()`, which reads the setting again. Saving also reloads every project's entry points, so triggers that failed while HA was not set up get subscribed.

### HA to Hobwork (triggers)

HA's WebSocket API has `subscribe_trigger`: the client sends a trigger definition in HA's own automation syntax, HA evaluates it, and pushes a message every time it fires. Hobwork uses this directly:

1. On deploy, the host reads the `homeassistant` triggers from `hobwork.json` and subscribes each one with `subscribe_trigger`.
2. A Zigbee button is pressed. ZHA or Zigbee2MQTT turns it into a device trigger, event or state change in HA. HA matches it against the subscription and pushes the trigger variables to Hobwork.
3. The host invokes the handler with the trigger variables, waking the project VM if needed.

Any trigger HA supports works (device, state, numeric_state, event, zone, time, template), with the same syntax as in an HA automation, and HA does the filtering. The `homeassistant` block is passed to HA unchanged. HA accepts both the current `"trigger": "state"` key and the older `"platform": "state"`; templates and docs use `trigger`, and device triggers from `ha_list_device_triggers` (which use `platform`) work as they are. The handler receives HA's trigger variables (`{ trigger: { platform, entity_id, from_state, to_state, ... } }`), the same object `ha_listen` returns.

On deploy the host diffs the project's triggers against its active subscriptions: unchanged triggers keep their subscription, changed ones are subscribed again, removed ones are unsubscribed. A trigger HA refuses (bad syntax, unknown device) is reported in the deploy result. On reconnect (e.g. HA restart) the host subscribes again. Triggers that fire while the connection is down are lost, and this is logged with the time range.

Agents find device IDs, entities and trigger payloads through the HA MCP tools. `ha_listen` lets an agent subscribe a trigger temporarily and ask the user to press the button, to see the real payload before writing the handler.

HA automations can also call a Hobwork webhook (`rest_command`), for anything easier to express on the HA side.

### Hobwork to HA (actions)

Handlers get `ctx.ha` (`packages/sdk/src/homeassistant.ts`): `callService(domain, service, data?, target?, { returnResponse? })`, `getState(entityId)` (undefined for an unknown entity), `getStates({ domain?, entityIds? })` and `fireEvent(type, data?)`. Calls go through the host, so the HA token never enters a VM and VMs do not need access to the LAN. Announcements on Google Home speakers are `tts.speak` or `media_player.play_media` calls.

- **Transport**: the runner POSTs `HaRequest` (`packages/sdk/src/runner/protocol.ts`) with the invocation ID to `http://hobwork.internal/v1/ha`, and the host answers it with its HA client (`server/src/homeassistant/internal.ts`). Failures answer `{ ok: false, error: { code, message } }` with HA's code and message, or Hobwork's (`not_configured` and `not_connected` 503, `timeout` 504, `read_only` 403, `bad_request` 400). The SDK throws them as `HomeAssistantError`. The runner and the handler bundle each have a copy of that class, so its `instanceof` checks a `Symbol.for` brand.
- **Logs**: every call is logged with its invocation, as a `runtime` line: service calls and events at `info`, reads at `debug`, failures at `warn`. The host checks that the invocation belongs to the VM's project, and the lines count toward the invocation's 1,000 line limit.
- **Branch previews** read states. Service calls and events answer `not_approved` (403) unless a person turned on "Let this branch control Home Assistant" for that branch on the project page (`PUT|DELETE /api/projects/<name>/branches/<branch>/home-assistant`, stored with who and when in `branch_ha_approvals`). It is checked on every call, so turning it off applies right away. Agents have no tool or token that can turn it on. A denied call is logged as a `warn` line with the invocation (`Home Assistant: denied light.turn_on ... Ask the user to turn on "Let this branch control Home Assistant" ...`), so the agent sees why and can ask.
- **Workspaces** read states only (`getState`, `getStates`, also as `hobwork ha state` and `hobwork ha states`). Code run there is work in progress and tests, and a test that switches off the heating by mistake has real effects, so service calls and events answer `read_only`. Tests fake `ctx.ha` with `createTestContext({ ha: { ... } })`, whose unstubbed methods reject. Pipeline VMs have no internal endpoint for HA. Rejected: an opt-in for service calls from workspaces; a deployed handler run with `invoke` does the same thing, with its version and logs recorded.

### Later

A custom HA integration (installed through HACS) that exposes Hobwork handlers as HA services or entities, so they can be used from the HA automation editor.

## Integrations

- **OpenRouter** (`packages/sdk/src/openrouter.ts`): `openrouter(ctx, { apiKey? })` returns `chat(request)` (the completion and its text) and `json(request)`. It POSTs to `https://openrouter.ai/api/v1/chat/completions` through `ctx.fetch` with the `OPENROUTER_API_KEY` placeholder in the `Authorization` header, so the user binds that secret to `openrouter.ai` and the value never reaches the handler. `json` without a schema uses JSON mode. With a schema it sends `response_format: json_schema` (strict by default) with `provider.require_parameters` so OpenRouter only routes to providers that support it, and validates the reply. Schemas are Standard Schema with Standard JSON Schema (`~standard.validate` and `~standard.jsonSchema`), which zod 4 implements, so the SDK needs no zod dependency. Errors throw `OpenRouterError` with the HTTP status and OpenRouter's message.
- **Visual programming**: undecided.

## Open questions

- Project routes: public URLs (for webhooks and NFC links) vs authenticated only. Probably per route.
- Can one project call another project's routes or emit events to it?
