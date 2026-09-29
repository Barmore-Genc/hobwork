# Working on this project

This is a Hobwork project. Hobwork runs its handlers (HTTP routes, crons, webhooks, triggers) and serves its dashboard. You change it on a branch, and `merge` tests, merges and deploys it.

## Layout

- `hobwork.json`: every entry point (routes, crons, webhooks, triggers), egress hosts and settings. Hobwork only runs what is declared here.
- `src/`: handlers and shared code. A handler file default-exports a function typed with `Handler` from `@hobwork/sdk` (`RequestHandler` for routes and webhooks). It gets one argument, the context: `ctx.request` (routes and webhooks), `ctx.params` (`:name` segments of the route path), `ctx.payload` (trigger event), `ctx.invocation`, `ctx.fetch`, `ctx.log`, `ctx.db`, `ctx.secrets`, `ctx.ha`, `ctx.device(name)` and `ctx.devices()`.
- Routes and webhooks answer with what the handler returns: a `Response` is sent as is, any other value as JSON, `undefined` as 204. A thrown error answers 500 and is recorded with its stack trace. Route `"GET /spools/:id"` answers `GET /api/spools/42` on the project's app origin (and `/p/<project>/api/spools/42` on the Hobwork host, with an agent token). A webhook is called at a secret URL that `rotate_webhook_token` returns.
- Crons use 5-field cron syntax in the Hobwork host's time zone.
- `ui/` and `index.html`: the dashboard (React + Tailwind), served at the root of the project's own origin (`https://<project>.<apps domain>/`) to signed-in household members and shown inside the Hobwork app. Each branch has a preview origin with its committed changes. `get_project`, `list_branches` and `hobwork status` show these URLs. Call the project's routes with `api` from `@hobwork/sdk/browser` (`api.get('spools')`, `api.post('spools', body)`), which requests `/api/...` on that origin with the session and the CSRF header that writes need. Every path without a file extension serves `index.html`, so client-side routes work. Paths under `/_hobwork/` are reserved. The page cannot call Hobwork's own API. Style with the theme utilities (`bg-bg`, `bg-surface`, `bg-surface-raised`, `border-border`, `text-fg`, `text-muted`, `bg-accent`, `text-accent-fg`, `text-on-accent`, `text-success`, `text-warning`, `text-danger`, `rounded-sm|md|lg`, `font-display`) rather than fixed colors, so the dashboard matches Hobwork and follows light and dark mode without `dark:` variants.
- `migrations/`: project DB migrations (`0001_name.sql`, ...), applied in order on deploy. See [Data](#data).
- `tests/`: Vitest tests. Test files share one module cache to keep the suite fast, so do not rely on module-level state being fresh in each file. Mocks, stubbed globals and env vars are reset after every test.
- `package.json`: scripts, plus extra npm packages only. The platform packages, `@hobwork/sdk` and `@hobwork/theme` come with the VM and are not listed here.

## Data

Each project has one SQLite DB. The schema comes from `migrations/`; handlers read and write rows with `ctx.db`:

```ts
const spools = await ctx.db.query<{ id: number; color: string }>('SELECT id, color FROM spools WHERE grams > ?', [100])
const spool = await ctx.db.get('SELECT * FROM spools WHERE id = :id', { id: 7 })
const { lastInsertRowid } = await ctx.db.run('INSERT INTO spools (color) VALUES (?)', ['red'])
await ctx.db.batch([
  { sql: 'UPDATE spools SET grams = grams - ? WHERE id = ?', params: [20, 7] },
  { sql: 'INSERT INTO prints (spool_id, grams) VALUES (?, ?)', params: [7, 20] },
])
```

- Every call is one request to Hobwork, so there are no interactive transactions. `batch` runs its statements in one transaction and rolls all of them back if one fails. For read-then-write logic, use one statement (`UPDATE ... WHERE`, `INSERT ... ON CONFLICT`, `RETURNING`) or a batch.
- One statement per SQL string. Statements cannot change the schema, use `PRAGMA` (other than introspection like `table_info`), `ATTACH` or `VACUUM`. Values are numbers, strings, `null` and `Uint8Array`; booleans are stored as 1 and 0.
- Migrations: add a new file for every change and never edit one that was merged. Create tables with `STRICT`. Only add tables, columns and indexes: `merge` applies new migrations to a copy of the production DB and refuses SQL errors and anything that drops or renames a table or column, so older versions keep working after a restore.
- Tests: `createTestDb()` from `@hobwork/sdk/testing` is a fresh in-memory DB with every migration applied and the same rules as `ctx.db`. `createTestContext({ ... })` builds a handler context with one (override `fetch`, `log`, `secrets` or `db` as needed).
- In the workspace, `hobwork sql "SELECT ..."` runs a statement on the branch DB: a copy of the production DB taken when the workspace VM started, with the branch's migrations applied. Editing an applied migration on the branch starts the branch DB over from a fresh copy.
- Slow queries (over 500ms) and a DB over 100 MB are logged as `db` events and shown in `get_project`. Add an index in a migration, or delete old rows.

## Secrets

Only the user creates secrets and sets their values, in the Hobwork UI. A secret reaches a project when it is assigned to it under an env name. `list_secrets` shows every secret with its hosts and the projects it is assigned to. When the project needs one:

1. If a fitting secret exists, assign it: `assign_secret` with the project, the secret's name and the env name the code uses (e.g. `SPOOL_API_KEY`).
2. Otherwise ask the user to create it in Hobwork, then assign it.
3. If the secret has no hosts or lacks one the code calls, ask for them with `request_secret_hosts` (every host it needs, and why). Show the user the link it returns. The hosts apply once they approve.

You cannot see values or change hosts yourself. Handlers never see values: `ctx.secrets.SPOOL_API_KEY` is a placeholder, and Hobwork replaces it with the real value in request headers sent to one of the secret's hosts:

```ts
await ctx.fetch('https://api.example.com/v1/spools', { headers: { authorization: `Bearer ${ctx.secrets.SPOOL_API_KEY}` } })
```

The placeholder is only replaced in headers, not in the URL or body. The hosts of assigned secrets are reachable without listing them in `egress`. `unassign_secret` takes a secret away from the project. Assignments show up in the project log.

## Home Assistant

Hobwork is connected to the household's Home Assistant. Find entities, services and device triggers with the `ha_*` tools; `ha_listen` shows the real payload of a trigger.

Triggers go in `hobwork.json`, in HA automation syntax. The handler gets HA's trigger variables as `ctx.payload`:

```json
"triggers": {
  "desk-button": { "homeassistant": { "trigger": "state", "entity_id": "input_button.desk" }, "handler": "src/desk-button.ts" }
}
```

Handlers act with `ctx.ha`:

```ts
await ctx.ha.callService('light', 'turn_on', { brightness_pct: 40 }, { area_id: 'living_room' })
const door = await ctx.ha.getState('binary_sensor.front_door') // undefined if the entity does not exist
const lights = await ctx.ha.getStates({ domain: 'light' })
await ctx.ha.fireEvent('print_done', { job: 42 })
const { response } = await ctx.ha.callService('weather', 'get_forecasts', { type: 'daily' }, { entity_id: 'weather.home' }, { returnResponse: true })
```

- Errors from Home Assistant (unknown service, invalid data, not connected) throw a `HomeAssistantError` from `@hobwork/sdk` with HA's `code` and `message`. Service calls are logged with the invocation.
- Announcements on a Google Home or other speaker: `tts.speak` with a TTS entity and the speaker, or `media_player.play_media` for an audio URL. `ha_list_entities` shows the `tts.*` and `media_player.*` entities.

  ```ts
  await ctx.ha.callService('tts', 'speak', { media_player_entity_id: 'media_player.kitchen', message: 'The print is done' }, { entity_id: 'tts.google_translate_en_com' })
  await ctx.ha.callService('media_player', 'play_media', { media_content_id: 'https://example.com/chime.mp3', media_content_type: 'music' }, { entity_id: 'media_player.kitchen' })
  ```

- Tests: `createTestContext({ ha: { callService: vi.fn() } })`. Methods a test does not stub reject.
- The workspace only reads states: `hobwork ha state <entity_id>` and `hobwork ha states [domain]`. Service calls and events only run from deployed handlers, so try them with `invoke` after `merge`.

## Devices

People pair their phones and computers with Hobwork through the Hobwork app. `list_devices` shows each device's name, owner, capabilities and whether it is connected. Handlers send notifications by device name:

```ts
const { id } = await ctx.device('kaan-iphone').notifications.send({
  title: 'Filament low',
  body: 'Spool 4 has 80 g left',
  actions: [{ id: 'order', title: 'Order more' }],
  data: { spool: 4 },
})
const devices = await ctx.devices() // [{ name, platform, owner, capabilities, connected, lastSeenAt }]
```

- A device that is not connected gets the notification by push. Failures (unknown device, not reachable) throw a `DeviceError` from `@hobwork/sdk` with a `code`. Sends are logged with the invocation.
- Tapping an action runs the project's triggers declared with a `device` block, with a `NotificationActionEvent` as `ctx.payload` (`{ device, notificationId, action, data }`, `data` being what the notification was sent with):

  ```json
  "triggers": {
    "order-tapped": { "device": { "capability": "notifications", "event": "action" }, "handler": "src/order-tapped.ts" }
  }
  ```

- Only deployed handlers reach devices. In the workspace and in branch previews, `ctx.devices()` works and sends fail with `read_only`, so try a notification with `invoke` after `merge`. In tests: `createTestContext({ device: () => ({ notifications: { send: vi.fn() } }) })`.

## LLMs (OpenRouter)

`openrouter(ctx)` from `@hobwork/sdk` calls models through OpenRouter. It needs an OpenRouter key assigned to the project as `OPENROUTER_API_KEY`. Look for one with `list_secrets`; if there is none, ask the user to create it in Hobwork with `openrouter.ai` as its host.

```ts
import { openrouter } from '@hobwork/sdk'
import { z } from 'zod'

const ai = openrouter(ctx)
const { text } = await ai.chat({ model: 'openai/gpt-5-mini', messages: [{ role: 'user', content: 'Name a red spool' }] })
const spool = await ai.json({
  model: 'openai/gpt-5-mini',
  messages: [{ role: 'user', content: `Read this spool label: ${label}` }],
  schema: z.object({ brand: z.string(), color: z.string(), grams: z.number() }),
})
```

- `json` with a `schema` asks for structured output and returns the checked, typed value. Without one it uses JSON mode and returns the parsed reply. Structured output is strict by default, which needs every field: use `.nullable()` instead of `.optional()`.
- Other fields (`temperature`, `max_tokens`, `reasoning`, `provider`, ...) are passed to OpenRouter. Errors throw an `OpenRouterError` with OpenRouter's message and HTTP `status`.
- Tests: pass a fake `fetch` and `secrets: { OPENROUTER_API_KEY: 'key' }` to `createTestContext`.

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
- Outgoing HTTP only reaches hosts listed in `egress` in `hobwork.json` and the hosts of secrets assigned to the project. Use `ctx.fetch`. Blocked requests get a 403 and an `egress-blocked` line in `get_logs`. In the branch workspace, a change to `egress` or to the assigned secrets applies from the next `bash` command, which restarts the workspace VM.
- Prefer the platform packages: React, Tailwind, Vite, Vitest, TypeScript, oxlint, zod, date-fns. Add another npm package only when none of these does the job, with `pnpm add <package>` in `bash`. Extra packages are installed again every time the workspace VM starts.
