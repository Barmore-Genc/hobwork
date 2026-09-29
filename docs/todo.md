# TODO

## Warm VM pool

Keep one booted spare VM per kind (runtime, workspace, pipeline) so a cold start takes an exec instead of a boot. Boot is about 0.7s on `colossus` and 0.5s on the Mac; a running VM answers a command in a few ms. Each spare costs about 175MB of host RSS. The spare has to be configured for the hob after boot (mounts, env, egress allowlist, secrets), so the `Sandbox` interface needs a way to apply these to a running VM, or the pool holds VMs per hob that is likely to start soon.

Other boot costs left, smaller and with more upkeep: a custom `rootfsInit` in the image (no debug output, parallel `modprobe`, no `update-ca-certificates` at boot), about 100-200ms; a custom kernel with the virtio and fuse drivers built in.

## Checking hobs against a new guest image

A platform set or SDK update takes effect for every hob at once, on its next workspace, pipeline run or build. Before switching to a new image, run every hob's pipeline against it. Hobs that fail stay on the old image until an agent fixes them, which needs images to be versioned and hobs to record the image they were tested with.

## claude.ai connectors

Connecting Hobwork as a custom connector in claude.ai, Claude Desktop and Cowork needs the host on public https. The OAuth flow is tested with the MCP SDK client and Claude Code only; check it end to end with claude.ai.

## Interrupting runaway queries

A hob DB query that runs longer than 30s is abandoned by terminating its worker, since SQLite cannot be interrupted from Node. Interrupt the query instead once Node exposes a way to (SQLite's `sqlite3_interrupt` or a progress handler), so the connection survives.

## More Home Assistant commands in `ctx.ha`

`ctx.ha` has service calls, states and events. Add `render_template` and other useful HA WebSocket commands.

## Home Assistant integration

A custom HA integration (installed through HACS) that exposes Hobwork handlers as HA services or entities, so they can be used from the HA automation editor.

## OpenRouter

- Streaming responses from the OpenRouter helper. The AI gateway gets answers to the guest only when they are complete, since Gondolin buffers answers from its `onRequest` hook; streaming needs Gondolin to pass a response body stream through.
- A spend limit across all hobs, next to the per-hob ones.
- Spend limits can be passed by one request, since cost is known only afterwards. Estimating a request's cost from `max_tokens` and the model's prices before sending it would close that gap.
- Tell people when a hob reaches a limit (a notification to their devices), not only in the hob log.

## Checking push notifications on a device

The host's APNs client is tested against a local HTTP/2 server, and the Apple app with unit tests and `just test-host` (`just test-host-mac` on macOS). Check APNs delivery and the web view sign-in on a real iPhone, and on a Mac with a team-signed build: the macOS app has only run signed ad hoc (`just run-mac local`), which gets no push token, no app group and no data protection keychain.

## Shared UI components

There is no component library in core; hob UIs use the theme's Tailwind utilities. If agents keep rewriting the same components across hobs, ship them in the platform set.

## Screen Time without the Family Controls entitlement

Last resort if Apple rejects the Family Controls distribution entitlement. No third-party blocker (Opal, one sec, Jomo, Brick, AppBlock, Freedom, [Foqos](https://github.com/awaseem/foqos)) has a remote API; they run on the device with the same entitlement, and their only integration point is their Shortcuts actions (App Intents). The Hobwork app cannot call another app's intents, but it can open `shortcuts://run-shortcut?name=<name>`, which runs a Shortcut the person built around the blocker's actions (for example Foqos "Start session").

- The app still sends no `screenTime` capability. A new capability maps set names to Shortcut names the person enters in the app's settings, one to block and one to unblock.
- A call arriving while the app is in the foreground opens the Shortcut. Otherwise the host sends a notification, and tapping it opens the app, which opens the Shortcut. The notification service extension cannot open URLs, so this always needs a tap.
- Schedules and limits are left to the blocker app or to Shortcuts personal automations (time of day, Focus, NFC), which run without Hobwork. Hobwork only knows the state if the Shortcut reports it back, for example through a Hobwork App Intent it calls last.
