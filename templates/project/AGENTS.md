# Working on this hob

This is a hob, a Hobwork project: handlers (routes, crons, webhooks, triggers) and a dashboard. Change it on a branch; `merge` tests, merges and deploys it.

## Layout

- `hobwork.json`: entry points, `egress` hosts, `csp` sources and settings, with comments allowed. Only what is declared here runs. `@hobwork/sdk/hobwork.schema.json` describes every field.
- Hob icon: set `icon` in hobwork.json (emoji or image path).
- `src/`: handlers. Each default-exports a function typed `Handler` (`RequestHandler` for routes and webhooks) from `@hobwork/sdk`. It gets `ctx`: `request`, `params`, `payload`, `invocation`, `fetch`, `log`, `db`, `secrets`, `ha`, `device(name)`, `devices()`.
- `ui/`, `index.html`: the dashboard (React + Tailwind) at the hob's app origin, also shown in the Hobwork app. Call routes with `api` from `@hobwork/sdk/browser` (`api.get('spools')`, `api.post('spools', body)`). Style with theme utilities (`bg-bg`, `bg-surface`, `border-border`, `text-fg`, `text-muted`, `bg-accent`, `text-accent-fg`, `text-danger`, ...), not fixed colors or `dark:`. `/_hobwork/` is reserved.
- The app runs under a strict Content-Security-Policy: scripts only from the app's own origin (no inline `<script>`, no `eval`, no CDN scripts), and connections, images, fonts and styles from its own origin (plus `data:`/`blob:` images and inline styles). Bundle dependencies with Vite instead of loading them from a CDN. If the UI really needs another source, add it in `hobwork.json`, e.g. `"csp": { "connect-src": ["https://api.example.com"], "img-src": ["https://*.tiles.example.com"] }` (directives: `script-src`, `style-src`, `img-src`, `font-src`, `connect-src`, `media-src`, `frame-src`, `worker-src`, `manifest-src`, `form-action`; sources are `https://host`, `wss://host` or `data:`/`blob:`). `'unsafe-inline'` and `'unsafe-eval'` are only accepted in `script-src` and remove the protection against injected scripts, so avoid them.
- `migrations/`: `0001_name.sql`, ..., applied in order on deploy.
- `tests/`: Vitest. Test files share one module cache; mocks, globals and env vars reset after each test.
- `package.json`: extra npm packages only. Platform packages, `@hobwork/sdk` and `@hobwork/theme` come with the VM.

## Handlers

- Route `"GET /spools/:id"` answers `GET /api/spools/42` on the app origin, with `ctx.params.id`. A returned `Response` is sent as is, other values as JSON, `undefined` as 204. A thrown error answers 500.
- Crons use 5-field syntax in the host's time zone. Webhooks are called at a secret URL from `rotate_webhook_token`.
- Handlers work like AWS Lambda functions: nothing in memory survives between invocations, and there are no servers, timers or background loops. Keep state in `ctx.db`, use a cron for recurring work.
- `ctx.fetch` only reaches hosts in `egress` and the hosts of assigned secrets. Blocked requests get a 403 and an `egress-blocked` log line. Workspace changes to either apply from the next `bash` command.
- Delete the greeting examples once the hob has its own handlers.

## Data

- `ctx.db.query`, `get`, `run` and `batch` (one transaction) take `?` params as an array or `:name` params as an object. Tests use `createTestDb()` and `createTestContext({ ... })` from `@hobwork/sdk/testing`.
- No interactive transactions. For read-then-write, use one statement (`UPDATE ... WHERE`, `ON CONFLICT`, `RETURNING`) or `batch`.
- One statement per call, no schema changes, `PRAGMA` (except introspection), `ATTACH` or `VACUUM`.
- Migrations are forward-only and additive: a new file per change, never edit a merged one, `STRICT` tables, never drop or rename tables or columns. `merge` refuses anything else.
- `hobwork sql "SELECT ..."` in the workspace queries the branch DB (a copy of production with the branch's migrations).

## Secrets

The user creates secrets and their hosts in the Hobwork UI. Find one with `list_secrets` and `assign_secret` it under an env name; if none fits, ask the user to create it. If it lacks a host the code calls, use `request_secret_hosts` and show the user the link. `ctx.secrets.NAME` is a placeholder that Hobwork replaces only in the `Authorization` header (`Bearer`, or `Basic` for a password) and in the headers the secret lists (`list_secrets` shows them as `headers`), and only over https to the secret's hosts. It is never filled into a URL, query string or body, so `?api_key=${ctx.secrets.KEY}` sends the placeholder. Send the secret in a header instead. If the API needs a header the secret does not list, ask the user to add it to the secret in Hobwork. A placeholder in any other header, or over http, fails the request with a 403 (`hobwork_secret_not_allowed`).

## Home Assistant

- Find entities, services and device triggers with the `ha_*` tools. `ha_listen` shows a trigger's real payload.
- Read data HA already has from HA instead of copying it into the DB, unless the user asks for a copy.
- Triggers go under `triggers` in HA automation syntax (`{ "homeassistant": { "trigger": "state", "entity_id": "input_button.desk" }, "handler": "src/desk.ts" }`). The payload is `ctx.payload`.
- A handler may call only the HA services on the hob's list, which starts empty. Add a domain (`light`) or service (`light.turn_on`) with `update_ha_services` before the code needs it, and tell the user; `get_hob` shows the list. A refused call throws `HomeAssistantError` with code `not_allowed` and is logged. `hassio.*`, `homeassistant.*`, `shell_command.*` and `recorder.purge*` are never allowed.
- Act with `ctx.ha.callService`, `getState`, `getStates`, `fireEvent`. Errors throw `HomeAssistantError`. Speak with `tts.speak` or `media_player.play_media`.
- The workspace only reads states (`hobwork ha state|states`). Try service calls with `invoke` after `merge`.

## Devices

`list_devices` shows paired devices and their `capabilities`; a call to one a device does not list fails with `unsupported`. Types are in `@hobwork/sdk` (`Device`, `DeviceEvent`).

- `ctx.device(name).notifications.send({ title, body, actions, data })`.
- `alarms`: `set({ title, at | time, days })`, `timer({ title, seconds })`, `cancel({ id })`, `list()`.
- `screenTime`: block app sets the person made in the app, by name: `sets()`, `block({ set, until })`, `unblock`, `schedule({ name, set, start, end, days })`, `limit({ name, set, minutes })`, `status()`.
- `focus.status()`, `nfc.write({ text })` (a Hobwork tag) or `nfc.write({ url, text })` (any http/https/mailto/tel/sms link) / `nfc.read()` (the person taps a notification and holds the phone to a tag; waits up to 2 minutes), `health.query({ type, from, to })`.
- Calls other than `notifications.send` throw `DeviceError` `timeout` after 30 s; the device may still run them within 10 minutes, and the result goes to the logs.
- Triggers: `{ "device": { "capability": "notifications", "event": "action" } }`, `focus`/`changed`, `nfc`/`scanned` (tags this hob wrote; with `"url": "<prefix>"` also other tags whose link starts with it), `health`/`samples`, optionally with `"device": "<name>"`. The event is `ctx.payload`.
- Only deployed handlers use devices; tests fake them with `createTestContext({ device: () => ({ alarms: { set } }) })`. Try with `invoke` after `merge`.

## LLMs

`openrouter(ctx)` from `@hobwork/sdk` has `chat` and `json` (with a zod `schema`; use `.nullable()`, not `.optional()`). It needs a secret with host `openrouter.ai` assigned as `OPENROUTER_API_KEY`. Both take `{ timeout, signal }` as a second argument (or `openrouter(ctx, { timeout })` for every call); a timeout throws `OpenRouterError` with code `timeout`.

### What AI is for

Use a model as an `if` or a `pick` inside a handler: evaluating a condition, or categorizing, tagging and filtering. Do not use it for agentic workflows, tool loops, chat interfaces or long generated text. Give it a small, closed question and act on the answer in code.

```ts
const ai = openrouter(ctx)
// true or false
const shipped = await ai.check('Does this email say the order has shipped?', { input: email.body })
// exactly one of the choices (an array, or an object of choice to description)
const label = await ai.pick('What kind of email is this?', ['bill', 'shipping', 'promo', 'other'] as const, { input: email })
```

`check(prompt, { model?, input?, timeout?, signal? })` returns a boolean. `pick(prompt, choices, options)` returns one of `choices`, typed as their union. Put the question in `prompt` and the data to judge in `input` (a string, or any JSON value); the model is told to treat `input` as data only, which makes it harder, not impossible, for text in it to change the question. Both use structured output at temperature 0 with a small token limit, and the default model is `DEFAULT_JUDGE_MODEL` (`google/gemini-2.5-flash-lite`). Pass `model` if it is not allowed for the hob. An answer that is not a boolean or not one of the choices throws `OpenRouterError` with code `invalid_output`; the helpers do not retry, so handle the error or let the invocation fail.

### Limits

People limit which models a hob may use and how many requests and dollars it may spend; `get_hob` shows the limits and current spend under `ai`. Every OpenRouter request counts, from workspaces and previews too, so tests fake `ctx.fetch` instead of calling OpenRouter. Past a limit, calls throw `OpenRouterError` with code `hobwork_model_not_allowed` (pick an allowed model), or `hobwork_rate_limit` or `hobwork_spend_limit` (`metadata.retry_after_seconds` says when to try again). Handle these instead of retrying in a loop. Only people change the limits, on the hob's AI page in Hobwork.

## Workflow

1. Create a branch. `main` is deployed and cannot be pushed to.
2. Change code, add tests, run `pnpm typecheck`, `pnpm lint`, `pnpm test`.
3. Commit, then `merge`. It checks, builds, squash-merges and deploys, or returns the failing output.
4. Confirm with `invoke`, `list_invocations` and `get_logs`. Debug from logs, do not guess. A deploy that fails completely is reverted (`auto-revert` in the logs).

Over SSH (`ssh <hob>/<branch>@<host>`), use `hobwork status|diff|commit|merge|logs|invocations`. The workspace has no git directory.

Prefer the platform packages (React, Tailwind, Vite, Vitest, TypeScript, oxlint, zod, date-fns). Add others with `pnpm add` only when none of them does the job. Commit `pnpm-lock.yaml` with the change: merging installs from it and fails without it. Versions released in the last 3 days are not installed, and install scripts of dependencies do not run unless the package is set to `true` under `allowBuilds` in `pnpm-workspace.yaml`.
