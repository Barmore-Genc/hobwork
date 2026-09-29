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

Status: done, covered end to end by `pnpm -C server test:vm` (template project merged over MCP, route over HTTP, cron by hand and on schedule, a thrown error found with `list_invocations` and `get_logs`, restore of a version without a stored build). Deferred: user sessions for routes (Phase 7). Deleting old builds was added later (see Housekeeping).

## Phase 6: Data, secrets, egress

- Project DBs owned by the host, SDK query API, migrations applied on deploy (with dry run in the pipeline).
- Branch DB copies for workspaces, empty DBs for tests.
- DB size and slow query warnings.
- Secrets: encrypted storage, bound hosts, placeholders in VMs. Egress allowlist from `hobwork.json` and secret hosts. Blocked requests logged.

Status: done, covered end to end by `pnpm -C server test:vm` (a deployed handler keeps rows across invocations, tests use `createTestDb` in the VM, `hobwork sql` reaches the branch DB, a migration that fails on production data blocks the merge, a secret bound to `postman-echo.com` is substituted while the guest sees the placeholder, and requests to other hosts, including ones that do not resolve, are blocked and logged). Secrets have JSON APIs, a host CLI and web UI pages (Phase 7). Secrets later moved from project and global scopes to one library that people fill and agents assign to projects over MCP (see Secrets and network in architecture.md). Backups of the host DB, project DBs, repos and secret key to S3 with Kopia came later (see Backups in architecture.md). Deferred: interrupting a runaway query instead of abandoning its worker, and invoking handlers against a branch DB.

## Phase 7: Web UI

- Login: pocket-id (OIDC) first.
- Projects overview, versions list with restore, invocations and logs, secrets management, agent access management.
- Serve project UIs at `/p/<project>/` with the theme stylesheet. Theme wired into the project template's Tailwind config.

Status: done. The first part added OIDC login with an allowlist, sessions and CSRF protection, the theme package served at `/theme/theme.css`, the host serving the built UI, the projects overview, versions with restore, and agent access management. Tested against Pocket ID in Docker (`dev/pocket-id/`). Project routes (`/p/<project>/api/*`) accept a signed-in user's session. The second part added the project pages (entry points with next cron runs, webhook URLs shown once on rotation, HA triggers, last runs, DB size and warnings, reachable hosts), activity with filters and each run's error, stack trace and log, the project log with live new lines (long poll), project and shared secrets pages, project UIs served at `/p/<project>/` from the deployed build for signed-in users and shown in an iframe, `@hobwork/theme` in the image and wired into the template's Tailwind setup, and the `@hobwork/sdk/browser` client. Covered by API and serving tests and by `pnpm -C server test:vm` (the template's UI served with the theme and calling its route with a session). The activity view across all projects was added later (see Housekeeping). Later, project UIs moved to their own origin per project, with a session handed over from Hobwork, and branches got previews at their own origins with routes, webhooks and invocations by hand, and Home Assistant control only after a person allows it (see Project app origins and Branch previews in architecture.md).

## Phase 8: Auth and access

- MCP OAuth 2.1 authorization server (for claude.ai / Cowork connectors), agent identities created on approval.
- Passkey login.
- SSH gateway into workspaces, `hobwork` CLI inside workspace VMs.

Status: done. The SSH gateway and the `hobwork` CLI are covered by `pnpm -C server test:vm` (the OpenSSH client runs `pnpm test`, an interactive shell, and `hobwork status`, `commit` and `merge` in a workspace VM). SSH keys are managed on the Agent access page, through the API and with the `add-ssh-key` script. Git over SSH is not supported. The MCP OAuth server (metadata documents and dynamic registration, consent page, rotating refresh tokens) is tested with the MCP SDK client and was verified with Claude Code (`claude mcp add` then `claude mcp login`, which identifies with its metadata document); claude.ai connectors need the host on public https, which is not tested yet. Passkeys (settings page, sign-in with discoverable credentials) are tested with a software authenticator and with Chromium's virtual authenticator. People without pocket-id enroll their first passkey through a `sign-in-link` URL. Deferred: rate limits on registration and authorization, per-project or read-only scopes, renaming passkeys.

## Phase 9: Integrations

- Home Assistant: WebSocket connection, `subscribe_trigger` for triggers in `hobwork.json`, SDK service calls through the host, HA MCP tools including `ha_listen`.
- OpenRouter SDK helper.

Status: done. Handlers call HA with `ctx.ha` through the host; workspaces only read. Covered by unit tests of the internal endpoint and the SDK, and with `HOBWORK_HA_TESTS=1` against the dev HA: a deployed handler toggles an `input_boolean`, and a trigger on `input_button.test_button` runs a handler that sets an `input_number` and fires an event. `pnpm -C server test:vm` checks that a handler built against the SDK in the image gets a `HomeAssistantError`. The OpenRouter helper is tested with a fake `fetch`, not against OpenRouter. HA settings in the web UI were added later (see Housekeeping). Deferred: `render_template` and other HA WebSocket commands in `ctx.ha`, and streaming from OpenRouter.

## Housekeeping

- Project deletion by people only, into a 7 day trash for the repo and DB.
- Old build cleanup on deploy and daily.
- Home Assistant connection in the web UI Settings, env vars still winning.
- Activity and problems across all projects.

Status: done. Covered by unit tests (deletion stops VMs, unsubscribes triggers, removes rows and files and frees the name; agents cannot delete; the trash purge; build retention and rebuilding a restored version whose build was deleted; HA settings encryption, precedence, reconnect and permissions; the cross-project activity API and its permissions) and with `HOBWORK_HA_TESTS=1` by saving the dev HA through the settings API. Deferred: restoring a deleted project from the trash in the UI.

## Phase 10: Apple apps

- iOS app (`dev.bgenc.hobwork`): login, WebView for project UIs, device WebSocket, push notifications.
- Capabilities in order: notifications, NFC read/write, alarms (AlarmKit), Screen Time (Family Controls, development entitlement first).
- Request the Family Controls distribution entitlement early so TestFlight is possible later.
- macOS app after iOS.

Status: host side of notifications done (milestone 1). Pairing through `/devices/connect` with PKCE, device tokens, one-time web view sign-in, the device WebSocket with calls, events and pings, notifications over the socket or APNs (HTTP/2, ES256 provider tokens with `node:crypto`), notification actions as `device` triggers in `hobwork.json`, `ctx.device`/`ctx.devices` in the SDK (deployed handlers only; workspaces and previews list), Devices under Settings in the web UI, and the read-only `list_devices` MCP tool. Covered by unit tests (pairing, tokens, web sessions, the WebSocket with a real client, call routing and timeouts, APNs requests against a local HTTP/2 server, the internal endpoint, a handler notifying a device and an action running its trigger) and by `pnpm -C server test:vm` (a handler built against the SDK in the image gets a `DeviceError`). Not tested against real APNs or the iOS app yet.
