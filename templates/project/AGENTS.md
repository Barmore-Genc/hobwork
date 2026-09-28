# Working on this project

This is a Hobwork project. Hobwork runs its handlers (HTTP routes, crons, webhooks, triggers) and serves its dashboard. You change it on a branch, and `merge` tests, merges and deploys it.

## Layout

- `hobwork.json`: every entry point (routes, crons, webhooks, triggers), egress hosts and settings. Hobwork only runs what is declared here.
- `src/`: handlers and shared code. A handler file default-exports a function typed with `Handler` from `@hobwork/sdk`.
- `ui/`: dashboard pages (React + Tailwind), served at `/p/<project>/`. Call the project's routes with relative URLs (`fetch('api/...')`).
- `migrations/`: project DB migrations (`0001_name.sql`, ...), applied in order on deploy.
- `tests/`: Vitest tests.

## Workflow

1. Create a branch. `main` is the deployed version and cannot be pushed to.
2. Make changes and add tests. Run `pnpm typecheck`, `pnpm lint`, `pnpm test` while you work.
3. Commit, then call `merge`. It runs typecheck, lint, tests and build on the branch rebased onto `main`. On success it squash-merges and deploys. On failure it returns the failing step and its output. Fix it and call `merge` again.
4. After deploying, check `list_invocations` and `get_logs` to confirm the change works.

## Rules

- Handlers work like AWS Lambda functions. Nothing in memory survives between invocations. Store state in the project DB through the SDK.
- There are no long-running processes. Do not start servers, timers or background loops in handlers. Use a cron for recurring work.
- Every change needs tests. `merge` refuses changes that fail typecheck, lint, tests or build.
- Migrations are forward-only and additive: add tables and columns, never drop or rename them. Older versions must keep working after a restore.
- Debug with `get_logs` and `list_invocations`. Do not guess.
- Outgoing HTTP only reaches hosts listed in `egress` in `hobwork.json` (and hosts bound to secrets). Use `ctx.fetch`.
- Prefer the platform packages: React, Tailwind, Vite, Vitest, TypeScript, oxlint, zod, date-fns. Add another npm package only when none of these does the job.
