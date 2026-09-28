# Working on Hobwork

Design source of truth: `docs/architecture.md` and `docs/plan.md`. Update them when the design changes.

## Layout

- `server/` (`@hobwork/server`): the host. Node runs the TypeScript directly, no build step.
- `web/` (`@hobwork/web`): Vite + React + Tailwind UI. Dev server proxies `/api` to the host on port 7420.
- `packages/sdk/` (`@hobwork/sdk`): SDK types and the `hobwork.json` JSON schema (`hobwork.schema.json`).
- `templates/project/`: template for new projects (not a workspace package).
- `apple/` (planned): Xcode projects for the iOS and macOS apps, bundle ID prefix `dev.bgenc.hobwork`. Not part of the pnpm workspace.
- `images/`: Gondolin guest image build config (Alpine, Node, pnpm, git, platform dependency set in `images/platform/`). Not part of the pnpm workspace. See `images/README.md`.
- `server/src/sandbox/`: the `Sandbox` interface and its Gondolin implementation. Nothing else in the host imports Gondolin.
- `dev/homeassistant/`: scripted local Home Assistant in Docker for testing the HA integration (`node dev/homeassistant/setup.ts`, creds land in the gitignored `.env.local`). See its README.
- `data/`: runtime data (gitignored). Override with `HOBWORK_DATA_DIR`. Port: `HOBWORK_PORT` (default 7420).

Only `server`, `web` and `packages/*` are pnpm workspace members (`pnpm-workspace.yaml`). Root scripts use `pnpm -r`, and tsconfig and oxlint are configured per package, so non-JS directories are never scanned. Do not add a root-level tsconfig `include` or root oxlint config.

## Commands

- `pnpm dev`: host (`node --watch`) and web in parallel.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`: run across the workspace.
- `images/build.sh`: build the guest image (needs Docker). Required for the VM commands below.
- `pnpm -C server test:vm`: sandbox tests that boot real VMs (skipped by `pnpm test`). Some need egress to `example.com` and `registry.npmjs.org`.
- `pnpm -C server bench:sandbox [vm|vfs]`: sandbox benchmarks.

## Connecting Claude Code to a local host

The MCP endpoint is `/mcp` (streamable HTTP, stateless). Create an agent token, then add the server:

```sh
pnpm --filter @hobwork/server create-token claude-code
claude mcp add --transport http hobwork http://localhost:7420/mcp --header "Authorization: Bearer <token>"
```

`bash` needs a workspace VM backend. Without one it returns a tool error and the other tools still work.

## Conventions

- Server and SDK use native type stripping: erasable syntax only (no enums, namespaces, parameter properties), `import type` for types, `.ts` extensions in relative imports.
- Code style: single quotes, no semicolons.
- SQLite: `node:sqlite`. Every connection sets WAL, `busy_timeout = 5000`, `synchronous = NORMAL`, `foreign_keys = ON` (see `server/src/db.ts`). All tables are `STRICT`.
- Migrations: numbered `.sql` files in `server/migrations/`, forward-only. Never edit an applied migration, add a new one.
- Never install anything globally. Dependencies are added with `pnpm add` inside the repo.
- Comments explain why, not what.
