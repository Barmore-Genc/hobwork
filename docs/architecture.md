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
- **Guest image**: a Hobwork-specific Gondolin image built from Alpine with Node, pnpm, git and a larger disk.
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

All Gondolin use goes through a small `Sandbox` interface in the host so the backend can be swapped (e.g. Docker) if it ever needs to be.

Measured on an Apple Silicon Mac (HVF, 512MB VMs):

| | |
|---|---|
| Create to first command | 300-450ms (one outlier 1.3s) |
| Command on a running VM | ~100ms |
| Node startup in guest | 100-170ms |
| Host RSS per VM | ~260MB fresh, ~380MB after use |
| 8 VMs in parallel | ready in 1.2s, ~2.1GB total |
| Concurrent commands in one VM | work, including alongside a long-running server |
| HTTPS request through egress proxy | ~700ms including TLS setup |

Numbers on `colossus` with KVM are still to be measured.

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
package.json           deps; scripts: typecheck, lint, test, build
pnpm-lock.yaml
tsconfig.json
vite.config.ts         UI build + Vitest config
hobwork.json           static project settings (egress hosts, idle timeout)
src/
  routes/*.ts          HTTP handlers, exposed at /p/<project>/api/...
  crons/*.ts           scheduled handlers
  events/*.ts          handlers for events (HA state changes, device events, other projects)
  lib/                 shared code
ui/                    dashboard pages (React + Tailwind)
migrations/*.sql       project DB migrations, applied in order
tests/                 Vitest tests
```

Handlers are registered in code with SDK helpers, e.g.:

```ts
// src/crons/morning-alarm.ts
import { cron } from "@hobwork/sdk";

export default cron("0 6 * * 1-5", async (ctx) => {
  const sleep = await ctx.fetch("https://health-export.example/api/sleep/last");
  ...
});
```

The host never imports project code, so it cannot read these definitions directly. The pipeline's build step runs the project's code inside the pipeline VM and writes a **manifest** (routes, crons, events, UI pages) that the host stores with the version. Scheduling and routing use the manifest.

### Branches and workspaces

- Each project is a bare repo on the host: `data/repos/<project>.git`.
- `main` is the deployed version. Nobody pushes to it directly. The only way in is a merge through the pipeline.
- Agents do work on branches. Each branch can have an **agent workspace** VM with the branch checked out.
- Branch data is isolated: a workspace gets a copy of the project DB taken when the workspace starts. Pipeline runs and tests get an empty DB with migrations applied.

## Agent access

Three ways in. All of them act on the same repos and workspaces.

1. **MCP** (primary; the only option for Claude Cowork and chat clients). See the tool list below.
2. **git smart HTTP**: `git clone https://hobwork/git/<project>.git`, work locally with Claude Code, push a branch. A pre-receive hook rejects pushes to `main`. After pushing, the agent calls `merge` over MCP (or over SSH).
3. **SSH gateway**: `ssh <project>/<branch>@hobwork` opens a shell in that branch's workspace VM. Also provides a `hobwork` CLI inside workspaces (`hobwork merge`, `hobwork logs -f`, `hobwork status`).

### MCP tools

Projects: `list_projects`, `create_project` (from template), `get_project` (manifest, current version, status).

Workspaces and files: `create_branch`, `list_branches`, `read_file`, `write_file`, `edit_file`, `delete_file`, `list_files`, `search`, `bash` (runs in the branch workspace VM), `commit`, `diff`, `log`.

Delivery: `merge` (runs the pipeline, squash-merges and deploys on success, returns failures otherwise), `pipeline_status`, `list_versions`, `restore_version`.

Runtime: `invoke` (call a route or trigger a cron/event by hand, on `main` or in a workspace), `list_invocations`, `get_logs`, `tail_logs`.

Secrets: `list_secrets` (names and bound hosts only, never values).

The MCP server's instructions point agents to the project's `AGENTS.md` and explain the core rules.

### Rules for agents

Written into `AGENTS.md` in every project and into the MCP server instructions:

- Handlers are like AWS Lambda functions. Nothing in memory survives between invocations. Store state with the SDK (project DB).
- Every change needs tests. `merge` runs typecheck, lint, tests and build, and refuses on failure.
- Migrations are forward-only and additive (add tables and columns, do not drop or rename), so older versions keep working after a restore.
- Use `get_logs` and `list_invocations` to debug. Do not guess.
- There are no long-running processes. Anything that needs to persist goes in the project DB.

## Delivery pipeline

`merge` on a branch:

1. Start a fresh pipeline VM with the candidate: the branch rebased (or merged) onto current `main`.
2. `pnpm install --frozen-lockfile`
3. `typecheck`, `lint`, `test`, `build` (package.json scripts from the template).
4. Extract the manifest.
5. Apply new migrations to a copy of the production DB, as a dry run.
6. On success: squash-merge into `main` with the agent's summary as the commit message, apply migrations for real, deploy.
7. On failure: return the failing step with its output to the agent. No human is involved. The agent fixes and calls `merge` again.

There is no human approval step. Users see the result as a new version in the UI.

Pipeline runs are recorded (step, status, output, duration) and visible to agents through `pipeline_status`.

## Versions and rollback

- Every merge is one squash commit on `main` = one version.
- The UI lists versions with their summaries. "Restore this version" commits that version's tree as a new commit on `main` and deploys it. History is never rewritten.
- Restoring code does not roll back data. Additive migrations keep this safe.
- **Auto-revert**: if a new version fails completely (runtime does not start, or every invocation fails for several minutes after deploy), Hobwork restores the previous version automatically and records why, so the agent can see it.

## Runtime

- Each deployed project has 0 or 1 runtime VMs. There is no scaling beyond 1. Concurrent invocations run in the same VM.
- The VM starts on the first invocation (HTTP request, cron tick, event) and stops after an idle timeout. Default 1 hour, configurable per project in `hobwork.json`. Cold start cost is the VM boot, roughly half a second.
- Inside the VM a Hobwork **runner** (Node) loads the deployed build and serves invocations from the host over the Gondolin ingress.
- The host owns scheduling. A cron tick wakes the VM if it is asleep.
- Deploy: start the new VM, wait until it is ready, switch traffic, drain and stop the old one.
- Handlers call back to the host (DB, logs, devices, events) through the SDK over an internal endpoint that only the project's VMs can reach.

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

## Integrations (later)

- **Home Assistant**: the host holds a WebSocket connection to HA and turns state changes into events for projects. Scripts call HA services through the SDK. Covers the Google Home announcements use case.
- **OpenRouter**: SDK helper for calling models, with the API key as a secret.
- **Visual programming**: undecided.

## Open questions

- Does the Gondolin VFS bridge perform well enough for `node_modules` in workspaces, or do workspaces need the checkout on the VM's own disk?
- What is the internal endpoint for SDK to host calls? Options: an intercepted hostname in the egress hooks, or an allowed internal host.
- Project routes: public URLs (for webhooks and NFC links) vs authenticated only. Probably per route.
- Can one project call another project's routes or emit events to it?
- Where do Hobwork's own backups go (repos, DBs, secrets)?
