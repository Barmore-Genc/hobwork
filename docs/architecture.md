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

- **Host**: Node (>= 23.6, runs TypeScript directly), pnpm. One process. Runs as a systemd service on `colossus` (Arch Linux, x86_64, KVM). Docker is possible with `--device /dev/kvm` but not the primary target.
- **Web UI**: React, TypeScript, Tailwind, Vite. Served by the host.
- **Guest image**: a Hobwork-specific Gondolin image built from Alpine with Node, pnpm, git, e2fsprogs and the platform dependency set (`images/`, built inside Docker by `images/build.sh`). VMs grow the root disk at boot (`diskSize`); root disk writes are discarded when a VM stops.
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
- **Blocked egress** is reported to the host through a callback (for logging). Requests to a host that does not resolve get a 502 instead of a 403.

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

Numbers on `colossus` are blocked: it has no `/dev/kvm`. The `kvm` module is loaded but `kvm_intel`/`kvm_amd` is not, and the user is not in the `kvm` group. Once that is fixed, run the same script there (see `images/README.md`).

### VM kinds

| Kind | Lifetime | Filesystem | Purpose |
|---|---|---|---|
| Project runtime | 0 or 1 per project. Starts on demand, stops after idle timeout | Deployed build of `main`, read-only | Runs handlers |
| Agent workspace | Per branch. Stops when idle, restarts on demand | Branch checkout, read-write | Agent bash, dev server, tests while iterating |
| Pipeline run | Fresh per run, discarded after | Clean checkout of the candidate commit | Install, typecheck, lint, test, build |

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
- **Routes**: authenticated API for the project's own dashboard, at `/p/<project>/api/...`.
- **Triggers**: events from integrations (Home Assistant, devices). The trigger payload is passed to the handler.

A handler file exports a default function that receives the invocation context:

```ts
import type { Handler } from "@hobwork/sdk";

export default (async (ctx) => {
  const res = await ctx.fetch("https://health-export.example/api/sleep/last");
  ...
}) satisfies Handler;
```

### Dependencies

The guest image contains one **platform dependency set** (React, Tailwind, Vite, Vitest, TypeScript, oxlint, zod, date-fns and similar) on the VM's own disk. Every project uses the same versions, so they are updated together.

- Updating the platform set means a new image version. Before switching, Hobwork runs every project's pipeline against the new image. Projects that fail stay on the old image until an agent fixes them.
- Projects can add extra npm packages in their `package.json`, installed on top of the platform set. This is allowed but discouraged, and `AGENTS.md` says so.

How the layering works (prototyped in `server/src/sandbox/gondolin.test.ts`):

- The platform set is a normal pnpm install at `/opt/hobwork/platform` (`images/platform/package.json` and its lockfile, exact versions). `/node_modules` is a symlink to `/opt/hobwork/platform/node_modules`, and `/opt/hobwork/platform/node_modules/.bin` is on `PATH`.
- Node, TypeScript, Vite and Vitest all resolve packages by walking up parent directories to `/node_modules`, so a project anywhere in the VM finds the platform packages and their types with no configuration. `NODE_PATH` is not used because ES modules ignore it.
- A project's `package.json` lists only its extras. `pnpm install` puts them in the project's own `node_modules`, which is found before `/node_modules`, so an extra could also override a platform package.
- The template sets `autoInstallPeers: false` in `pnpm-workspace.yaml`. Without it, pnpm installs a second React for an extra that has React as a peer dependency. With it, the peer resolves to the platform React through the same parent-directory lookup.
- Installing extras needs egress to `registry.npmjs.org`. Only the install step gets it.

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
- Vitest time is dominated by module imports, not the filesystem: every test file runs isolated and imports `date-fns` from scratch (~750ms in the guest, ~420ms in a Docker container on the same Mac). `--no-isolate` brings the run to 1.2s. Pipeline and workspace VMs get 4 vCPUs. The template should make its Vitest config cheap per file (for example `pool: 'threads'` or pre-bundling large dependencies); decide in Phase 2.

### Branches and workspaces

- Each project is a bare repo on the host: `data/repos/<project>.git`.
- `main` is the deployed version. Nobody pushes to it directly. The only way in is a merge through the pipeline.
- Agents do work on branches. Each branch can have an **agent workspace** VM with the branch checked out.
- A workspace's checkout lives on the host at `data/workspaces/<project>/<branch>/`, with the branch's files in `files/` and the git directory in `git/`. The VM mounts only `files/`. The host runs all git commands for the workspace (`commit`, `diff`, `log`) with an explicit git directory, so nothing the VM writes (git config, hooks, filters) is ever executed on the host. `commit` pushes to the branch in the bare repo.
- Branch data is isolated: a workspace gets a copy of the project DB taken when the workspace starts. Pipeline runs and tests get an empty DB with migrations applied.

## Agent access

Three ways in. All of them act on the same repos and workspaces.

1. **MCP** (primary; the only option for Claude Cowork and chat clients). See the tool list below.
2. **git smart HTTP**: `git clone https://hobwork/git/<project>.git`, work locally with Claude Code, push a branch. A pre-receive hook rejects pushes to `main`. After pushing, the agent calls `merge` over MCP (or over SSH).
3. **SSH gateway**: `ssh <project>/<branch>@hobwork` opens a shell in that branch's workspace VM. Also provides a `hobwork` CLI inside workspaces (`hobwork merge`, `hobwork logs -f`, `hobwork status`).

### MCP tools

Projects: `list_projects`, `create_project` (from template), `get_project` (entry points, current version, status).

Workspaces and files: `create_branch`, `list_branches`, `read_file`, `write_file`, `edit_file`, `delete_file`, `list_files`, `search`, `bash` (runs in the branch workspace VM), `commit`, `diff`, `log`.

Delivery: `merge` (runs the pipeline, squash-merges and deploys on success, returns failures otherwise), `pipeline_status`, `list_versions`, `restore_version`.

Runtime: `invoke` (call a route or trigger a cron/event by hand, on `main` or in a workspace), `list_invocations`, `get_logs`, `tail_logs`.

Secrets: `list_secrets` (names and bound hosts only, never values).

Home Assistant: `ha_list_devices`, `ha_list_entities`, `ha_get_state`, `ha_list_services`, `ha_list_device_triggers` (ready-made trigger definitions for a device), and `ha_listen` (wait for a trigger to fire, so an agent can ask the user to press a button and see the resulting payload). Listings take filters and are paged, since real installs have thousands of entities.

The MCP server's instructions point agents to the project's `AGENTS.md` and explain the core rules.

The endpoint is streamable HTTP at `/mcp`, stateless (a fresh server per request), authenticated with a bearer agent token until MCP OAuth replaces it. File tools act on the branch workspace checkout on the host and reject paths and symlinks that lead outside it. `main` is readable through a host-only checkout reset to the branch tip on each read. Writes, `bash` and `commit` on `main` are refused. `search` matches in a worker thread with a deadline, so an agent-supplied regular expression cannot block the host. `bash` runs through the workspace VM's `exec` (see `ExecWorkspaceVm` in `server/src/workspaces.ts`) with a timeout, and long output is cut in the middle.

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
5. Apply new migrations to a copy of the production DB, as a dry run.
6. On success: squash-merge into `main` with the agent's summary as the commit message, apply migrations for real, deploy.
7. On failure: return the failing step with its output to the agent. No human is involved. The agent fixes and calls `merge` again.

There is no human approval step. Users see the result as a new version in the UI.

Pipeline runs are recorded (step, status, output, duration) and visible to agents through `pipeline_status`.

Details:

- `merge` takes only committed changes and refuses while the workspace has uncommitted ones.
- The candidate is built in a temporary host-side clone: the branch is squashed into one commit (author: the agent, committer: Hobwork, message: the agent's summary) and rebased onto `main`. Squashing first means only the branch's end result has to apply. On conflict, the conflicting files are returned and the agent redoes the change on a new branch from `main`.
- Merges and restores run one at a time per project, so each candidate is tested against the `main` it lands on.
- The pipeline VM gets a clean checkout of the candidate with no git directory. `hobwork.json` and `package.json` are read on the host from git, never from the checkout. Extra dependencies are the `package.json` dependencies not in the platform set. The platform set is defined by `templates/project/package.json`.
- After a successful merge, the branch and its workspace checkout are reset to the new `main` (ignored files like `node_modules` stay), so the agent can keep working on the same branch. If the branch changed while the merge ran, it is left as it was.
- The pipeline VM backend is a seam (`StartPipelineVm` in `server/src/pipeline/runner.ts`). `server/src/pipeline/host-backend.ts` runs commands on the host without a sandbox and exists only for tests.

## Versions and rollback

- Every merge is one squash commit on `main` = one version. Version 1 is the template commit from project creation.
- The UI lists versions with their summaries. "Restore this version" commits that version's tree as a new commit on `main`, records it as a new version and deploys it, without running the pipeline. History is never rewritten.
- Restoring code does not roll back data. Additive migrations keep this safe.
- **Auto-revert**: if a new version fails completely (runtime does not start, or every invocation fails for several minutes after deploy), Hobwork restores the previous version automatically and records why, so the agent can see it.

## Runtime

- Each deployed project has 0 or 1 runtime VMs. There is no scaling beyond 1. Concurrent invocations run in the same VM.
- The VM starts on the first invocation (HTTP request, cron tick, event) and stops after an idle timeout. Default 1 hour, configurable per project in `hobwork.json`. Cold start cost is the VM boot, roughly half a second.
- Inside the VM a Hobwork **runner** (Node) loads the deployed build and serves invocations from the host over the Gondolin ingress.
- The host owns scheduling and trigger subscriptions. A cron tick, webhook call or trigger wakes the VM if it is asleep.
- Deploy: start the new VM, wait until it is ready, switch traffic, drain and stop the old one.
- Handlers call back to the host (DB, logs, devices, events) through the SDK over an internal endpoint that only the project's VMs can reach.

### Internal endpoint

The SDK talks to the host at `http://hobwork.internal/` (HTTPS works too, through Gondolin's TLS interception). The hostname does not exist anywhere. Every sandbox is created with its own `internal` handler, and Gondolin's egress `onRequest` hook answers requests for `hobwork.internal` with that handler's `Response` before any DNS lookup, allowlist check or upstream connection.

- The handler is bound to the VM when it is created, so the host knows which project, version and workspace a call comes from without a token in the guest.
- Nothing else on the host is reachable. Host services on `127.0.0.1`, `10.0.2.2` and internal ranges are blocked by the egress policy, and no TCP port is forwarded.
- Secrets are substituted after `onRequest`, and none is bound to `hobwork.internal`, so the handler only ever sees placeholders.

Rejected: an allowed internal host (a real host port through `allowedInternalHosts`) would need auth tokens in the guest and exposes a real socket.

### Invocations and logs

Every invocation is recorded: ID, project, version, trigger (route, cron, event, manual), start, duration, result, error with stack trace. Console output from handlers is captured per invocation. Pipeline output and runtime lifecycle events (start, stop, crash, auto-revert) go to the same log store.

Agents read this through MCP (`list_invocations`, `get_logs`, `tail_logs`) and the `hobwork logs` CLI over SSH. Users see it in the UI.

## Data

- **Host DB**: SQLite for Hobwork's own state (users, agents, tokens, projects, versions, invocations, logs, pipeline runs, secrets metadata).
- **Project DBs**: one SQLite file per project, owned by the host. Project code reaches it through the SDK, which sends queries to the host. VMs do not open DB files directly, because SQLite locking and WAL shared memory do not work reliably through the guest filesystem bridge across VMs.
- Migrations: `migrations/*.sql` in the repo, applied in order on deploy, tracked in the project DB.
- Warnings: the host watches DB size and slow queries per project and reports them in logs and project status, so agents notice before it becomes a problem.
- All SQLite databases use WAL, `busy_timeout`, `synchronous = NORMAL`, `foreign_keys = ON` and `STRICT` tables.

## Secrets and network

- Secrets are per project (plus optional global ones), created by users in the UI. Each secret is bound to the hosts it may be sent to.
- Values are encrypted at rest and never shown to agents or sent into VMs. VMs get placeholders.
- A project's egress allowlist comes from `hobwork.json` plus the hosts of its secrets. Changes to `hobwork.json` show up in the version diff in the UI.
- Blocked requests are logged, so an agent can see why a fetch failed.

## Dashboards and UI

- Project UIs are plain React + Tailwind pages under `ui/`, built by the pipeline with Vite, and served by the host at `/p/<project>/`.
- The host provides one theme stylesheet with CSS variables (colors, radii, fonts, light/dark). The template's Tailwind setup maps these to utility classes (`bg-surface`, `text-muted`, ...). Anything that uses them stays on theme, including third-party components.
- No component library in core. Projects can add any npm package. Shared components can be added later if agents keep rewriting the same ones.
- The SDK has a browser client for calling the project's own routes with the user's session.
- The Hobwork web UI and the Apple apps show project UIs in an iframe or WebView.

## Users and authentication

- **Users**: a small fixed set (the household). Login with OIDC (pocket-id) and passkeys (WebAuthn), so the project works for other people who do not run pocket-id.
- **Agents**: separate identities, not tied to a user. Users create and revoke agent access in the UI.
- **MCP auth**: Hobwork acts as an OAuth 2.1 authorization server for MCP, as required by claude.ai and Cowork custom connectors. A user logs in and approves the connection, which creates an agent identity. Claude Code can use the same flow or a static token.
- **git HTTP**: agent token as the password.
- **SSH**: public keys registered to an agent.
- Agents can do everything on projects except manage users, agents and secret values.

## Devices (Apple apps)

- The app keeps a WebSocket to the host and registers the device and its capabilities.
- Scripts call capabilities through the SDK: `ctx.device("kaan-iphone").nfc.write(...)`.
- If a capability needs the app in the foreground (NFC), the host sends a push notification. Tapping it opens the app straight into the action.
- NFC tags written by Hobwork contain a URL that opens the app (universal link), not the browser.

Planned capabilities:

- **Notifications** (APNs), with actions that send events back to scripts.
- **NFC** read and write (Core NFC, foreground only, system scan sheet).
- **Alarms** (AlarmKit, iOS 26+).
- **Screen Time**: block apps and set limits (Family Controls, Managed Settings, Device Activity). The development entitlement works for our own devices through Xcode builds. TestFlight and App Store need Apple to approve the distribution entitlement. macOS support is still to be checked.
- **HealthKit** (possible): read sleep data directly, instead of going through a Health export API.

## Home Assistant

The host keeps one WebSocket connection to HA, authenticated with a long-lived access token entered in the Hobwork settings. Until the settings UI exists, the URL and token come from `HOBWORK_HA_URL` and `HOBWORK_HA_TOKEN`. The connection is pinged, and reconnects with exponential backoff (1s up to 60s) when it drops.

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

The SDK has `ha.callService(domain, service, data)`, `ha.getState(entity)` and similar. Calls go through the host, so the HA token never enters a VM and VMs do not need access to the LAN. Announcements on Google Home speakers are `tts.speak` or `media_player.play_media` calls.

### Later

A custom HA integration (installed through HACS) that exposes Hobwork handlers as HA services or entities, so they can be used from the HA automation editor.

## Integrations (later)

- **OpenRouter**: SDK helper for calling models, with the API key as a secret.
- **Visual programming**: undecided.

## Open questions

- Project routes: public URLs (for webhooks and NFC links) vs authenticated only. Probably per route.
- Can one project call another project's routes or emit events to it?
- Where do Hobwork's own backups go (repos, DBs, secrets)?
