# Working on this project

This is a Hobwork project. Hobwork runs its handlers (HTTP routes, crons, webhooks, triggers) and serves its dashboard. You change it on a branch, and `merge` tests, merges and deploys it.

## Layout

- `hobwork.json`: every entry point (routes, crons, webhooks, triggers), egress hosts and settings. Hobwork only runs what is declared here.
- `src/`: handlers and shared code. A handler file default-exports a function typed with `Handler` from `@hobwork/sdk` (`RequestHandler` for routes and webhooks). It gets one argument, the context: `ctx.request` (routes and webhooks), `ctx.params` (`:name` segments of the route path), `ctx.payload` (trigger event), `ctx.invocation`, `ctx.fetch` and `ctx.log`.
- Routes and webhooks answer with what the handler returns: a `Response` is sent as is, any other value as JSON, `undefined` as 204. A thrown error answers 500 and is recorded with its stack trace. Route `"GET /spools/:id"` answers `GET /p/<project>/api/spools/42`. A webhook is called at a secret URL that `rotate_webhook_token` returns.
- Crons use 5-field cron syntax in the Hobwork host's time zone.
- `ui/`: dashboard pages (React + Tailwind), served at `/p/<project>/`. Call the project's routes with relative URLs (`fetch('api/...')`).
- `migrations/`: project DB migrations (`0001_name.sql`, ...), applied in order on deploy.
- `tests/`: Vitest tests. Test files share one module cache to keep the suite fast, so do not rely on module-level state being fresh in each file. Mocks, stubbed globals and env vars are reset after every test.
- `package.json`: scripts, plus extra npm packages only. The platform packages and `@hobwork/sdk` come with the VM and are not listed here.

## Workflow

1. Create a branch. `main` is the deployed version and cannot be pushed to.
2. Make changes and add tests. Run `pnpm typecheck`, `pnpm lint`, `pnpm test` while you work.
3. Commit, then call `merge`. It runs typecheck, lint, tests and build on the branch rebased onto `main`. On success it squash-merges and deploys. On failure it returns the failing step and its output. Fix it and call `merge` again.
4. After deploying, run a handler with `invoke` and check `list_invocations` and `get_logs` to confirm the change works. `pnpm build` must produce `dist/handlers/` (see `vite.config.ts`), since that is what runs.

In a shell in the workspace (over SSH, `ssh <project>/<branch>@<hobwork host>`), the `hobwork` command does the same: `hobwork status`, `hobwork diff`, `hobwork commit "<message>"`, `hobwork merge "<summary>"`, `hobwork logs [-f]` and `hobwork invocations`. The workspace has no git directory, so commit with `hobwork commit`.

## Rules

- Handlers work like AWS Lambda functions. Nothing in memory survives between invocations. Store state in the project DB through the SDK.
- There are no long-running processes. Do not start servers, timers or background loops in handlers. Use a cron for recurring work.
- Every change needs tests. `merge` refuses changes that fail typecheck, lint, tests or build.
- Migrations are forward-only and additive: add tables and columns, never drop or rename them. Older versions must keep working after a restore.
- Debug with `get_logs` and `list_invocations`. Do not guess. Console output and `ctx.log` lines are stored per invocation.
- If a merged version fails completely (its runtime does not start, or every invocation fails for several minutes), Hobwork restores the previous version and logs why. Check `get_logs` for `auto-revert` events.
- Outgoing HTTP only reaches hosts listed in `egress` in `hobwork.json` (and hosts bound to secrets). Use `ctx.fetch`. In the branch workspace, a change to `egress` applies from the next `bash` command, which restarts the workspace VM.
- Prefer the platform packages: React, Tailwind, Vite, Vitest, TypeScript, oxlint, zod, date-fns. Add another npm package only when none of these does the job, with `pnpm add <package>` in `bash`. Extra packages are installed again every time the workspace VM starts.
