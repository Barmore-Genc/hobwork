# TODO

## Warm VM pool

Keep one booted spare VM per kind (runtime, workspace, pipeline) so a cold start takes an exec instead of a boot. Boot is about 0.7s on `colossus` and 0.5s on the Mac; a running VM answers a command in a few ms. Each spare costs about 175MB of host RSS. The spare has to be configured for the project after boot (mounts, env, egress allowlist, secrets), so the `Sandbox` interface needs a way to apply these to a running VM, or the pool holds VMs per project that is likely to start soon.

Other boot costs left, smaller and with more upkeep: a custom `rootfsInit` in the image (no debug output, parallel `modprobe`, no `update-ca-certificates` at boot), about 100-200ms; a custom kernel with the virtio and fuse drivers built in.

## Project icons

Let each project set its own icon, used for its app's favicon and home screen icon and wherever the web UI and the Apple apps list projects. `hobwork.json` gets an `icon` field that takes either an emoji or a path to an image in the repo (SVG, PNG, JPEG, WebP). The build step renders it to the sizes each place needs (favicon, `apple-touch-icon`, web manifest icons, the project list), so the project code never deals with sizes or formats. Projects without an icon get a generated default (first letter on a theme color).

The template's `hobwork.json` should include the field with a placeholder, and the JSON schema should describe it, so agents see it and set one when they create a project. Mention it in the template's `AGENTS.md` too.

## Device capabilities in the Apple apps

Expose more of the phone to handlers through `ctx.device`, as calls over the device WebSocket or as `device` triggers. Phase 10 in `plan.md` has the order for the first ones.

- NFC: read and write tags (Core NFC, NDEF). Scanning a tag can fire a trigger. Reading needs the app in the foreground, unless the tag holds a URL that opens the app.
- Apple Health: read samples (HealthKit) for handlers to query or sync, with the person choosing which types to share.
- Alarms and timers: create, edit, delete and turn off alarms and countdown timers (AlarmKit). This covers alarms the app made; alarms in the Clock app are out of reach.
- Screen Time and Focus: block or allow apps and turn it on or off on a schedule or from a handler (Family Controls, Managed Settings, Device Activity). Use case: a handler that blocks certain apps on a phone at a set time. iOS has no public API to turn Focus modes on or off; check whether a Shortcuts action the app provides can do it.
