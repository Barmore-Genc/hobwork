# Implementation plan

Phases are ordered so each one ends with something usable. The MVP is phases 0 to 5: an agent can create a project over MCP, change it on a branch, get it tested and merged, and have it run with logs.

See [architecture.md](architecture.md) for the design.

## Phase 0: Repository scaffold

- pnpm workspace: `server/`, `web/`, `packages/sdk/`, `templates/project/`.
- `hobwork.json` JSON schema.
- Host: Node + TypeScript (native type stripping), Vitest, oxlint.
- Web: Vite, React, Tailwind (already scaffolded).
- Host DB setup with SQLite defaults and a simple migration runner.
- Config via env vars (`HOBWORK_DATA_DIR`, `HOBWORK_PORT`, ...).
- `CLAUDE.md` for working on Hobwork itself.

Done when: `pnpm dev` starts host and web, `pnpm test` runs, the web UI loads.

## Phase 1: Sandbox layer

- `Sandbox` interface in the host, Gondolin implementation.
- Hobwork guest image: Alpine + Node + pnpm + git, larger root disk, platform dependency set.
- Decide how extra per-project dependencies layer on top of the platform set.
- Benchmark on `hobwork-host` with KVM (boot, exec, memory, egress), same script as the Mac run. Done, numbers in architecture.md.
- Test Gondolin VFS performance for `vitest` and `tsc` in a mounted checkout vs on the VM disk. Decide how workspaces hold their files.
- Decide and prototype the internal SDK to host endpoint.

Done when: the host can start a VM with a directory mounted, run a command with streamed output, and stop it, with numbers from `hobwork-host`.

Status: done. Mac and `hobwork-host` numbers (KVM, bare host; VM tests pass there too), the dependency layering, the workspace file layout and the internal endpoint are in architecture.md.

## Phase 2: Projects and git

- Bare repos under `data/repos/`, project records in the host DB.
- `create_project` from `templates/project/` (package.json, configs, example route + cron + test, `AGENTS.md`).
- Branches and workspaces: per-branch checkout and workspace VM, idle stop.
- git smart HTTP (`git http-backend`) with token auth and a pre-receive hook rejecting `main`.

Done when: a project can be created, cloned over HTTP, a branch pushed, and a push to `main` is rejected.

Status: done. Workspace and pipeline VMs run on the `Sandbox` with idle stop, covered end to end by `pnpm -C server test:vm` (template project checked in a workspace VM and merged through a pipeline VM over MCP).

## Phase 3: MCP server

- Streamable HTTP MCP endpoint with static agent tokens for now (OAuth comes in phase 8).
- Tools: projects, branches, file operations, `bash`, `commit`, `diff`, `log`.
- Server instructions explaining the rules and pointing to `AGENTS.md`.

Done when: Claude Code connected over MCP can create a project, edit files on a branch, and run commands in the workspace.

## Phase 4: Pipeline, merge, versions

- Pipeline runner: fresh VM, validate `hobwork.json`, install extras, typecheck, lint, test, build. Records steps and output.
- `merge`: pipeline on the branch rebased onto `main`, squash-merge on success, failures returned to the agent.
- `pipeline_status`, `list_versions`, `restore_version`.

Done when: an agent can merge a branch, gets test failures back when tests fail, and can restore an older version.

## Phase 5: Runtime and logs

- SDK: `Handler` type, context with `fetch`, logging.
- Runner inside the VM: loads the deployed build, serves invocations over ingress.
- Host: 0/1 VM lifecycle with idle timeout, routes (`/p/<project>/api/*`), webhooks (`/hooks/...`), cron scheduler, deploy with switch-over.
- Invocation records and captured logs. MCP: `invoke`, `list_invocations`, `get_logs`, `tail_logs`.
- Auto-revert on total failure after deploy.

Done when: a merged route answers HTTP requests, a cron fires on schedule, and an agent can find a thrown error and its stack trace through MCP. **MVP complete.**

Status: done, covered end to end by `pnpm -C server test:vm` (template project merged over MCP, route over HTTP, cron by hand and on schedule, a thrown error found with `list_invocations` and `get_logs`, restore of a version without a stored build). Deferred: `invoke` in a branch workspace, deleting old builds, user sessions for routes (Phase 7).

## Phase 6: Data, secrets, egress

- Project DBs owned by the host, SDK query API, migrations applied on deploy (with dry run in the pipeline).
- Branch DB copies for workspaces, empty DBs for tests.
- DB size and slow query warnings.
- Secrets: encrypted storage, bound hosts, placeholders in VMs. Egress allowlist from `hobwork.json` and secret hosts. Blocked requests logged.

Status: done, covered end to end by `pnpm -C server test:vm` (a deployed handler keeps rows across invocations, tests use `createTestDb` in the VM, `hobwork sql` reaches the branch DB, a migration that fails on production data blocks the merge, a secret bound to `postman-echo.com` is substituted while the guest sees the placeholder, and requests to other hosts, including ones that do not resolve, are blocked and logged). Secrets have JSON APIs and a host CLI; their web UI is Phase 7. Deferred: backups of project DBs, interrupting a runaway query instead of abandoning its worker, and invoking handlers against a branch DB.

## Phase 7: Web UI

- Login: pocket-id (OIDC) first.
- Projects overview, versions list with restore, invocations and logs, secrets management, agent access management.
- Serve project UIs at `/p/<project>/` with the theme stylesheet. Theme wired into the project template's Tailwind config.

Status: done are OIDC login with an allowlist, sessions and CSRF protection, the theme package served at `/theme/theme.css`, the host serving the built UI, the projects overview, versions with restore, and agent access management. Tested against Pocket ID in Docker (`dev/pocket-id/`). Project routes (`/p/<project>/api/*`) accept a signed-in user's session. Still to do: invocations and logs pages, secrets management (the JSON API exists), serving project UIs at `/p/<project>/`, and wiring the theme into the project template.

## Phase 8: Auth and access

- MCP OAuth 2.1 authorization server (for claude.ai / Cowork connectors), agent identities created on approval.
- Passkey login.
- SSH gateway into workspaces, `hobwork` CLI inside workspace VMs.

Status: done. The SSH gateway and the `hobwork` CLI are covered by `pnpm -C server test:vm` (the OpenSSH client runs `pnpm test`, an interactive shell, and `hobwork status`, `commit` and `merge` in a workspace VM). SSH keys are managed on the Agent access page, through the API and with the `add-ssh-key` script. Git over SSH is not supported. The MCP OAuth server (metadata documents and dynamic registration, consent page, rotating refresh tokens) is tested with the MCP SDK client and was verified with Claude Code (`claude mcp add` then `claude mcp login`, which identifies with its metadata document); claude.ai connectors need the host on public https, which is not tested yet. Passkeys (settings page, sign-in with discoverable credentials) are tested with a software authenticator and with Chromium's virtual authenticator. People without pocket-id enroll their first passkey through a `sign-in-link` URL. Deferred: rate limits on registration and authorization, per-project or read-only scopes, renaming passkeys.

## Phase 9: Integrations

- Home Assistant: WebSocket connection, `subscribe_trigger` for triggers in `hobwork.json`, SDK service calls through the host, HA MCP tools including `ha_listen`.
- OpenRouter SDK helper.

Status: done. Handlers call HA with `ctx.ha` through the host; workspaces only read. Covered by unit tests of the internal endpoint and the SDK, and with `HOBWORK_HA_TESTS=1` against the dev HA: a deployed handler toggles an `input_boolean`, and a trigger on `input_button.test_button` runs a handler that sets an `input_number` and fires an event. `pnpm -C server test:vm` checks that a handler built against the SDK in the image gets a `HomeAssistantError`. The OpenRouter helper is tested with a fake `fetch`, not against OpenRouter. Deferred: HA settings in the web UI (the connection still comes from env vars), `render_template` and other HA WebSocket commands in `ctx.ha`, and streaming from OpenRouter.

## Phase 10: Apple apps

- iOS app (`dev.bgenc.hobwork`): login, WebView for project UIs, device WebSocket, push notifications.
- Capabilities in order: notifications, NFC read/write, alarms (AlarmKit), Screen Time (Family Controls, development entitlement first).
- Request the Family Controls distribution entitlement early so TestFlight is possible later.
- macOS app after iOS.
