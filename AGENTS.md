Hobwork is a self hosted micro-app service that is designed to be agentic AI-native.
Hobwork serves the UI, and runs the server side in AWS Lambda-like transient environment.
Each micro-app is called a "hob" after the helpful household spirits.

If needed, reference `docs` folder. Update relevant docs when TODOs are closed out or design decisions are made.


## Layout

- `server/` (`@hobwork/server`): the host.
- `web/` (`@hobwork/web`): Vite + React + Tailwind UI. Dev server proxies requests to the host. The host serves the build (`pnpm -C web build`, `web/dist`) itself
- `packages/theme/` (`@hobwork/theme`): theme stylesheet and its Tailwind mapping, shared by the web UI and hob UIs
- `packages/sdk/` (`@hobwork/sdk`): SDK types, `hobwork.schema.json`, the runner (`src/runner/`), `hobwork` CLI (`src/cli/`), and the file and git tools the host runs in workspace VMs (`src/workspace-tools/`), the hob icon renderer (`src/icons/`), and the migration runner (`src/db/migrate-main.ts`). These get mounted into VMs as needed
- `vendor/gondolin/`: See `CHANGES.md` to see vendored changes. `images/build.sh` builds the guest helpers and image
- `templates/project/`: template for new projects (not a workspace package)
- `apple/`: iOS and macOS app using SwiftUI. XcodeGen from `project.yml`
- `relay/`: the push notification relay (Rust, axum, rusqlite), which sends APNs pushes for hosts.
- `images/`: Gondolin guest image build config
- `server/src/sandbox/`: the `Sandbox` interface and its Gondolin implementation
- `server/src/ssh/`: SSH gateway into workspace VMs.
- `server/src/auth/`: web sessions, OIDC, passkeys and sign-in links
- `server/src/oauth/`: authorization server for MCP clients
- `server/src/devices/`: pairing, device tokens, app WebSocket (`/api/devices/ws`), notifications or APNs, triggers. Device protocol in `docs/device-protocol.md`
- `server/src/runtime/`: hob runtime VMs, builds, invocations and logs, crons, routes and webhooks
- `server/src/data/`: hob DBs (a worker thread per DB), migrations and their pipeline dry run, branch DB copies
- query executor, migration runner in `packages/sdk/src/db/`
- secrets in `server/src/secrets.ts`
- `server/src/backup/`: daily backups to S3 with Kopia
- `dev`: Docker setup for local testing, see readme.

Only `server`, `web`, `packages/*` and `vendor/*` are pnpm workspace members (`pnpm-workspace.yaml`). Root scripts use `pnpm -r`, tsconfig and oxlint are configured per package. Do not add a root-level tsconfig `include` or root oxlint config.

## Commands

- `pnpm dev`: host (`node --watch`) and web in parallel
- `pnpm typecheck`, `pnpm lint`, `pnpm test`: run across the workspace
- `images/build.sh`: build the guest image using Docker. Built in CI, rebuild locally as needed for VM tests
- `pnpm -C server test:vm`: sandbox, workspace, pipeline, SSH, runtime VM tests that boot real VMs (skipped by `pnpm test`), some tests require network access
- VMs need hardware acceleration: KVM on Linux, HVF on macOS. Never run VMs or VM tests under QEMU emulation (TCG), in Docker or anywhere else or the suite takes hours. If the machine has no acceleration, for example Docker Desktop on a Mac, **stop and ask the user**
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
- Comments explain why, not what.

