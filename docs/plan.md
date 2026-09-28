# Implementation plan

Phases are ordered so each one ends with something usable. The MVP is phases 0 to 5: an agent can create a project over MCP, change it on a branch, get it tested and merged, and have it run with logs.

See [architecture.md](architecture.md) for the design.

## Phase 0: Repository scaffold

- pnpm workspace: `server/`, `web/`, `packages/sdk/`, `templates/project/`.
- Host: Node + TypeScript (native type stripping), Vitest, oxlint.
- Web: Vite, React, Tailwind (already scaffolded).
- Host DB setup with SQLite defaults and a simple migration runner.
- Config via env vars (`HOBWORK_DATA_DIR`, `HOBWORK_PORT`, ...).
- `CLAUDE.md` for working on Hobwork itself.

Done when: `pnpm dev` starts host and web, `pnpm test` runs, the web UI loads.

## Phase 1: Sandbox layer

- `Sandbox` interface in the host, Gondolin implementation.
- Hobwork guest image: Alpine + Node + pnpm + git, larger root disk.
- Benchmark on `hobwork-host` with KVM (boot, exec, memory, egress), same script as the Mac run.
- Test Gondolin VFS performance for `pnpm install` and `vitest` in a mounted checkout vs on the VM disk. Decide how workspaces hold their files.
- Decide and prototype the internal SDK to host endpoint.

Done when: the host can start a VM with a directory mounted, run a command with streamed output, and stop it, with numbers from `hobwork-host`.

## Phase 2: Projects and git

- Bare repos under `data/repos/`, project records in the host DB.
- `create_project` from `templates/project/` (package.json, configs, example route + cron + test, `AGENTS.md`).
- Branches and workspaces: per-branch checkout and workspace VM, idle stop.
- git smart HTTP (`git http-backend`) with token auth and a pre-receive hook rejecting `main`.

Done when: a project can be created, cloned over HTTP, a branch pushed, and a push to `main` is rejected.

## Phase 3: MCP server

- Streamable HTTP MCP endpoint with static agent tokens for now (OAuth comes in phase 8).
- Tools: projects, branches, file operations, `bash`, `commit`, `diff`, `log`.
- Server instructions explaining the rules and pointing to `AGENTS.md`.

Done when: Claude Code connected over MCP can create a project, edit files on a branch, and run commands in the workspace.

## Phase 4: Pipeline, merge, versions

- Pipeline runner: fresh VM, install, typecheck, lint, test, build, manifest extraction. Records steps and output.
- `merge`: pipeline on the branch rebased onto `main`, squash-merge on success, failures returned to the agent.
- `pipeline_status`, `list_versions`, `restore_version`.

Done when: an agent can merge a branch, gets test failures back when tests fail, and can restore an older version.

## Phase 5: Runtime and logs

- SDK: `route`, `cron`, `event` helpers, context with `fetch`, logging.
- Runner inside the VM: loads the deployed build, serves invocations over ingress.
- Host: 0/1 VM lifecycle with idle timeout, routing `/p/<project>/api/*`, cron scheduler, deploy with switch-over.
- Invocation records and captured logs. MCP: `invoke`, `list_invocations`, `get_logs`, `tail_logs`.
- Auto-revert on total failure after deploy.

Done when: a merged route answers HTTP requests, a cron fires on schedule, and an agent can find a thrown error and its stack trace through MCP. **MVP complete.**

## Phase 6: Data, secrets, egress

- Project DBs owned by the host, SDK query API, migrations applied on deploy (with dry run in the pipeline).
- Branch DB copies for workspaces, empty DBs for tests.
- DB size and slow query warnings.
- Secrets: encrypted storage, bound hosts, placeholders in VMs. Egress allowlist from `hobwork.json` and secret hosts. Blocked requests logged.

## Phase 7: Web UI

- Login: pocket-id (OIDC) first.
- Projects overview, versions list with restore, invocations and logs, secrets management, agent access management.
- Serve project UIs at `/p/<project>/` with the theme stylesheet. Theme wired into the project template's Tailwind config.

## Phase 8: Auth and access

- MCP OAuth 2.1 authorization server (for claude.ai / Cowork connectors), agent identities created on approval.
- Passkey login.
- SSH gateway into workspaces, `hobwork` CLI inside workspace VMs.

## Phase 9: Apple apps

- iOS app (`dev.bgenc.hobwork`): login, WebView for project UIs, device WebSocket, push notifications.
- Capabilities in order: notifications, NFC read/write, alarms (AlarmKit), Screen Time (Family Controls, development entitlement first).
- Request the Family Controls distribution entitlement early so TestFlight is possible later.
- macOS app after iOS.

## Phase 10: Integrations

- Home Assistant: WebSocket connection, state change events, service calls from the SDK.
- OpenRouter SDK helper.
