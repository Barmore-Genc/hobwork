# Working on Hobwork

Design source of truth: `docs/architecture.md` and `docs/plan.md`. Update them when the design changes.

## Layout

- `server/` (`@hobwork/server`): the host. Node runs the TypeScript directly, no build step.
- `web/` (`@hobwork/web`): Vite + React + Tailwind UI. Dev server proxies `/api`, `/auth`, `/theme`, `/oauth`, `/.well-known` and `/mcp` to the host on port 7420. The host serves the build (`pnpm -C web build`, `web/dist`) itself.
- `packages/theme/` (`@hobwork/theme`): theme stylesheet (CSS variables, served at `/theme/theme.css`) and its Tailwind mapping, shared by the web UI and project UIs.
- `packages/sdk/` (`@hobwork/sdk`): SDK types, the `hobwork.json` JSON schema (`hobwork.schema.json`), the runner (`src/runner/`) that the host mounts into project runtime VMs, and the `hobwork` CLI (`src/cli/`) that it mounts into workspace VMs.
- `templates/project/`: template for new projects (not a workspace package).
- `apple/` (planned): Xcode projects for the iOS and macOS apps, bundle ID prefix `dev.bgenc.hobwork`. Not part of the pnpm workspace.
- `images/`: Gondolin guest image build config (Alpine, Node, pnpm, git, platform dependency set in `images/platform/`). Not part of the pnpm workspace. See `images/README.md`.
- `server/src/sandbox/`: the `Sandbox` interface and its Gondolin implementation. Nothing else in the host imports Gondolin. `server/src/guest-vm.ts` builds the workspace and pipeline VM backends on it.
- `server/src/ssh/`: SSH gateway into workspace VMs and agent SSH keys. The `hobwork` CLI it offers lives in `packages/sdk/src/cli/` and is mounted into workspace VMs; `server/src/workspace-api.ts` answers it.
- `server/src/auth/`: web sessions, OIDC, passkeys and sign-in links. `server/src/oauth/`: the OAuth authorization server for MCP clients.
- `server/src/runtime/`: project runtime VMs, builds, invocations and logs, crons, routes and webhooks.
- `server/src/data/`: project DBs (a worker thread per DB), migrations and their pipeline dry run, branch DB copies. The query executor and migration runner shared with `@hobwork/sdk/testing` are in `packages/sdk/src/db/`. Secrets are in `server/src/secrets.ts`.
- `dev/homeassistant/`: scripted local Home Assistant in Docker for testing the HA integration (`node dev/homeassistant/setup.ts`, creds land in the gitignored `.env.local`). The host connects to HA when `HOBWORK_HA_URL` and `HOBWORK_HA_TOKEN` are set. Integration tests against it run with `HOBWORK_HA_TESTS=1`. See its README.
- `dev/pocket-id/`: scripted local Pocket ID in Docker for web UI sign-in (`node dev/pocket-id/setup.ts` writes host settings to the gitignored `.env.local`, `login-link` prints a passkey-free login link). See its README.
- `data/`: runtime data (gitignored). Override with `HOBWORK_DATA_DIR`. Port: `HOBWORK_PORT` (default 7420). Guest image: `HOBWORK_IMAGE_DIR` (default `images/build/<arch>`). Workspace VM idle stop: `HOBWORK_WORKSPACE_IDLE_MINUTES` (default 30). SSH gateway: `HOBWORK_SSH_PORT` (default 2222, `off` to disable). Secrets key: `HOBWORK_SECRET_KEY` (64 hex characters; default: `secret.key` in the data dir, created on first start). Web sign-in: `HOBWORK_PUBLIC_URL` (origin the browser uses, default `http://localhost:<port>`; use `http://localhost:5173` with the Vite dev server), `HOBWORK_OIDC_ISSUER`, `HOBWORK_OIDC_CLIENT_ID`, `HOBWORK_OIDC_CLIENT_SECRET`, `HOBWORK_OIDC_NAME`, `HOBWORK_ALLOWED_USERS` (emails and `sub:<subject>`).

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

For SSH into a workspace, register a public key to an agent and connect with `<project>/<branch>` as the user:

```sh
pnpm --filter @hobwork/server add-ssh-key claude-code ~/.ssh/id_ed25519.pub
ssh -p 2222 filament/add-spools@localhost
```

Without pocket-id, sign in with a one-time link and add a passkey in Settings (the email must be in `HOBWORK_ALLOWED_USERS`):

```sh
pnpm --filter @hobwork/server sign-in-link you@example.com --name "Your Name"
```

Secrets are created by users on the Secrets page and assigned to projects under an env name (agents can assign over MCP). From a shell on the host: `printf %s "$VALUE" | pnpm --filter @hobwork/server secret create "Spoolman API key" --host api.example.com`, then `secret assign <project> "Spoolman API key" SPOOLMAN_TOKEN` (also `list`, `update`, `delete`, `unassign`).

`bash` needs a workspace VM backend and `merge` needs a pipeline VM backend. Without them these tools return an error and the other tools still work.

## Conventions

- Server and SDK use native type stripping: erasable syntax only (no enums, namespaces, parameter properties), `import type` for types, `.ts` extensions in relative imports.
- Code style: single quotes, no semicolons.
- SQLite: `node:sqlite`. Every connection sets WAL, `busy_timeout = 5000`, `synchronous = NORMAL`, `foreign_keys = ON` (see `server/src/db.ts`). All tables are `STRICT`.
- Migrations: numbered `.sql` files in `server/migrations/`, forward-only. Never edit an applied migration, add a new one.
- Never install anything globally. Dependencies are added with `pnpm add` inside the repo.
- Comments explain why, not what.
