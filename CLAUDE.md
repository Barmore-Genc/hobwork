# Working on Hobwork

Design source of truth: `docs/architecture.md` (what the system is) and `docs/todo.md` (what is planned or missing). Update them when the design changes.

## Layout

- `server/` (`@hobwork/server`): the host. Node runs the TypeScript directly, no build step.
- `web/` (`@hobwork/web`): Vite + React + Tailwind UI. Dev server proxies `/api` (with WebSockets), `/auth`, `/theme`, `/oauth`, `/.well-known` and `/mcp` to the host on port 7420. The host serves the build (`pnpm -C web build`, `web/dist`) itself.
- `packages/theme/` (`@hobwork/theme`): theme stylesheet (CSS variables, served at `/theme/theme.css`) and its Tailwind mapping, shared by the web UI and project UIs.
- `packages/sdk/` (`@hobwork/sdk`): SDK types, the `hobwork.json` JSON schema (`hobwork.schema.json`), the runner (`src/runner/`) that the host mounts into project runtime VMs, the `hobwork` CLI (`src/cli/`) that it mounts into workspace VMs, and the project icon renderer (`src/icons/`) that it mounts into pipeline VMs.
- `templates/project/`: template for new projects (not a workspace package).
- `apple/`: the Apple app for iOS and macOS (`dev.bgenc.hobwork`, SwiftUI, iOS 26 and macOS 26, Swift 6). XcodeGen generates `Hobwork.xcodeproj` from `project.yml` (the project is gitignored); `just build|test|run` (iOS) and `just build-mac|test-mac|run-mac` inside `apple/`. Not part of the pnpm workspace. See `apple/README.md`.
- `images/`: Gondolin guest image build config (Alpine, Node, pnpm, git, platform dependency set in `images/platform/`). Not part of the pnpm workspace. See `images/README.md`.
- `server/src/sandbox/`: the `Sandbox` interface and its Gondolin implementation. Nothing else in the host imports Gondolin. `server/src/guest-vm.ts` builds the workspace and pipeline VM backends on it.
- `server/src/ssh/`: SSH gateway into workspace VMs and agent SSH keys. The `hobwork` CLI it offers lives in `packages/sdk/src/cli/` and is mounted into workspace VMs; `server/src/workspace-api.ts` answers it.
- `server/src/auth/`: web sessions, OIDC, passkeys and sign-in links. `server/src/oauth/`: the OAuth authorization server for MCP clients.
- `server/src/devices/`: devices running the Apple apps: pairing, device tokens, the app's WebSocket (`/api/devices/ws`), notifications over it or APNs, and notification actions as triggers. The contract with the apps is "Device protocol" in `docs/architecture.md`.
- `server/src/runtime/`: project runtime VMs, builds, invocations and logs, crons, routes and webhooks.
- `server/src/data/`: project DBs (a worker thread per DB), migrations and their pipeline dry run, branch DB copies. The query executor and migration runner shared with `@hobwork/sdk/testing` are in `packages/sdk/src/db/`. Secrets are in `server/src/secrets.ts`.
- `server/src/backup/`: daily backups of the data dir to S3 with Kopia (staging, Kopia commands, runs, `/api/backups`). The CLI is `pnpm --filter @hobwork/server backup now|list|verify|restore`.
- `dev/backups/`: MinIO in Docker and a `kopia` wrapper that runs Kopia in Docker (`HOBWORK_KOPIA_BIN=dev/backups/kopia`). Integration tests against it run with `HOBWORK_BACKUP_TESTS=1`. See its README.
- `dev/homeassistant/`: scripted local Home Assistant in Docker for testing the HA integration (`node dev/homeassistant/setup.ts`, creds land in the gitignored `.env.local`). People connect HA on the web UI's Settings page; `HOBWORK_HA_URL` and `HOBWORK_HA_TOKEN`, when set, win over that. Integration tests against it run with `HOBWORK_HA_TESTS=1`. See its README.
- `dev/pocket-id/`: scripted local Pocket ID in Docker for web UI sign-in (`node dev/pocket-id/setup.ts` writes host settings to the gitignored `.env.local`, `login-link` prints a passkey-free login link). See its README.
- `release/`: `package.sh <version>` packages the host as a tarball in `release/out/` (gitignored). `.github/workflows/release.yml` checks PRs and pushes to `main`, and builds the tarball on `main`, manual runs and `v*` tags (tags also get a GitHub release). See Releases in `docs/architecture.md`.
- `data/`: runtime data (gitignored). Override with `HOBWORK_DATA_DIR`. Port: `HOBWORK_PORT` (default 7420). Guest image: `HOBWORK_IMAGE_DIR` (default `images/build/<arch>`). Workspace VM idle stop: `HOBWORK_WORKSPACE_IDLE_MINUTES` (default 30). Guest boot log on the serial console (x86_64): `HOBWORK_VM_CONSOLE=1`. QEMU seccomp filter (Linux only): `HOBWORK_QEMU_SANDBOX=1`. SSH gateway: `HOBWORK_SSH_PORT` (default 2222, `off` to disable). Secrets key: `HOBWORK_SECRET_KEY` (64 hex characters; default: `secret.key` in the data dir, created on first start). Web sign-in: `HOBWORK_PUBLIC_URL` (origin the browser uses, default `http://localhost:<port>`; use `http://hobwork.localhost:5173` with the Vite dev server, so hob apps are the same site), `HOBWORK_APPS_URL` (apps host; each hob UI is served at `<hob>.<apps host>`, default `apps.<public host>`; with the Vite dev server `http://apps.hobwork.localhost:7420`), `HOBWORK_OIDC_ISSUER`, `HOBWORK_OIDC_CLIENT_ID`, `HOBWORK_OIDC_CLIENT_SECRET`, `HOBWORK_OIDC_NAME`, `HOBWORK_ALLOWED_USERS` (emails and `sub:<subject>`, or `*` for everyone the OIDC provider signs in). Backups: `HOBWORK_BACKUP_S3_BUCKET` turns them on (see Backups in `docs/architecture.md` for the rest). Push notifications (APNs, token auth): `HOBWORK_APNS_KEY_FILE` (the `.p8` key), `HOBWORK_APNS_KEY_ID`, `HOBWORK_APNS_TEAM_ID`, all three or none; without them notifications only reach devices whose app is connected. Universal links for NFC tags: `HOBWORK_APPLE_APP_ID` (`<team ID>.<bundle ID>` in `/.well-known/apple-app-site-association`, default `63QQLP356Q.dev.bgenc.hobwork`). Reverse proxies: `HOBWORK_TRUSTED_PROXIES` (IPs and CIDR ranges whose `X-Forwarded-For` names the client, empty by default).

Only `server`, `web` and `packages/*` are pnpm workspace members (`pnpm-workspace.yaml`). Root scripts use `pnpm -r`, and tsconfig and oxlint are configured per package, so non-JS directories are never scanned. Do not add a root-level tsconfig `include` or root oxlint config.

## Commands

- `pnpm dev`: host (`node --watch`) and web in parallel.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`: run across the workspace.
- `images/build.sh`: build the guest image (needs Docker). Required for the VM commands below and for `bash` and `merge` in the host. Rebuild after changing `packages/sdk`, since the image contains it.
- `pnpm -C server test:vm`: sandbox, workspace, pipeline, SSH and runtime VM tests that boot real VMs (skipped by `pnpm test`). The runtime test waits for a cron tick, so it takes about a minute. Some need egress to `example.com`, `registry.npmjs.org` and `postman-echo.com`.
- `pnpm -C server bench:sandbox [vm|vfs]`: sandbox benchmarks.

## Connecting Claude Code to a local host

The MCP endpoint is `/mcp` (streamable HTTP, stateless). Add it without a token and sign in through the browser (OAuth; approving creates an agent):

```sh
claude mcp add --transport http hobwork http://localhost:7420/mcp
claude mcp login hobwork
```

Or create a static agent token and send it as a header:

```sh
pnpm --filter @hobwork/server create-token claude-code
claude mcp add --transport http hobwork http://localhost:7420/mcp --header "Authorization: Bearer <token>"
```

For SSH into a workspace, register a public key to an agent (agents can also add their own with the `add_ssh_key` MCP tool) and connect with `<hob>/<branch>` as the user:

```sh
pnpm --filter @hobwork/server add-ssh-key claude-code laptop ~/.ssh/id_ed25519.pub
ssh -p 2222 filament/add-spools@localhost
```

Without pocket-id, sign in with a one-time link and add a passkey in Settings (the email must be in `HOBWORK_ALLOWED_USERS`):

```sh
pnpm --filter @hobwork/server sign-in-link you@example.com --name "Your Name"
```

Secrets are created by users on the Secrets page and assigned to hobs under an env name (agents can assign over MCP). From a shell on the host: `printf %s "$VALUE" | pnpm --filter @hobwork/server secret create "Spoolman API key" --host api.example.com`, then `secret assign <hob> "Spoolman API key" SPOOLMAN_TOKEN` (also `list`, `update`, `delete`, `unassign`).

`bash` needs a workspace VM backend and `merge` needs a pipeline VM backend. Without them these tools return an error and the other tools still work.

## Conventions

- Server and SDK use native type stripping: erasable syntax only (no enums, namespaces, parameter properties), `import type` for types, `.ts` extensions in relative imports.
- Code style: single quotes, no semicolons.
- SQLite: `node:sqlite`. Every connection sets WAL, `busy_timeout = 5000`, `synchronous = NORMAL`, `foreign_keys = ON` (see `server/src/db.ts`). All tables are `STRICT`.
- Migrations: numbered `.sql` files in `server/migrations/`, forward-only. Never edit an applied migration, add a new one.
- Never install anything globally. Dependencies are added with `pnpm add` inside the repo.
- Comments explain why, not what.
