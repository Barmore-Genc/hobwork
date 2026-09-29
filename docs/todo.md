# TODO

## Warm VM pool

Keep one booted spare VM per kind (runtime, workspace, pipeline) so a cold start takes an exec instead of a boot. Boot is about 0.7s on `colossus` and 0.5s on the Mac; a running VM answers a command in a few ms. Each spare costs about 175MB of host RSS. The spare has to be configured for the project after boot (mounts, env, egress allowlist, secrets), so the `Sandbox` interface needs a way to apply these to a running VM, or the pool holds VMs per project that is likely to start soon.

Other boot costs left, smaller and with more upkeep: a custom `rootfsInit` in the image (no debug output, parallel `modprobe`, no `update-ca-certificates` at boot), about 100-200ms; a custom kernel with the virtio and fuse drivers built in.

## Storage use in the projects list

Show how much disk each project uses in the web UI's projects list, with the project DB broken out since it is the part that grows. Other parts worth counting: the bare repo, branch DB copies, builds and logs. Agents get the same numbers from the `list_projects` and `get_project` MCP tools. Sizes can be read from the data dir; cache them or compute them in the background so the list stays fast.

## Live updates in the web UI

A WebSocket from the host that tells open pages when something changed (projects, versions, invocations, branches, secrets, agent access), so lists refresh on their own instead of on reload. The project log's long poll could move onto it.

## Restoring deleted projects

Deleted projects sit in `<dataDir>/trash/` for 7 days, but bringing one back is a manual step on the host (move the repo and DB back, create the project row and versions). Add a trash view to the web UI that lists deleted projects with who deleted them and when they are purged, and restores one when its name is still free.

## Checking projects against a new guest image

A platform set or SDK update takes effect for every project at once, on its next workspace, pipeline run or build. Before switching to a new image, run every project's pipeline against it. Projects that fail stay on the old image until an agent fixes them, which needs images to be versioned and projects to record the image they were tested with.

## OAuth hardening

- Rate limits on dynamic client registration (`/oauth/register`) and on authorization requests, so a script cannot fill `oauth_clients` and `oauth_requests`.
- Scopes: a connection or agent token can do everything an agent can. Add per-project and read-only scopes, chosen on the consent page and when creating a token.

## claude.ai connectors

Connecting Hobwork as a custom connector in claude.ai, Claude Desktop and Cowork needs the host on public https. The OAuth flow is tested with the MCP SDK client and Claude Code only; check it end to end with claude.ai.

## Renaming passkeys

Passkeys can be added and deleted in Settings, not renamed. Add a name people can set, so several passkeys can be told apart.

## Interrupting runaway queries

A project DB query that runs longer than 30s is abandoned by terminating its worker, since SQLite cannot be interrupted from Node. Interrupt the query instead once Node exposes a way to (SQLite's `sqlite3_interrupt` or a progress handler), so the connection survives.

## More Home Assistant commands in `ctx.ha`

`ctx.ha` has service calls, states and events. Add `render_template` and other useful HA WebSocket commands.

## Home Assistant integration

A custom HA integration (installed through HACS) that exposes Hobwork handlers as HA services or entities, so they can be used from the HA automation editor.

## OpenRouter

- Streaming responses from the OpenRouter helper.
- The helper is tested with a fake `fetch` only. Test it against OpenRouter.

## Checking push notifications on a device

The host's APNs client is tested against a local HTTP/2 server, and the iOS app with unit tests and `just test-host`. Check APNs delivery and the web view sign-in on a real device.

## macOS app

A macOS version of the Apple app, with pairing, the web UI in a web view, the device WebSocket and notifications, like the iOS app.

## Shared UI components

There is no component library in core; project UIs use the theme's Tailwind utilities. If agents keep rewriting the same components across projects, ship them in the platform set.
