# TODO

## Security hardening

From the security audit of 2026-09-29. Two threats, in order of how they arrive:

- **A bug in agent-written hob code** that someone outside finds and exploits: a webhook or route that reflects input into HTML, XSS in a hob UI, an injection that runs code in the runtime VM, SSRF through a handler. The goal is that one buggy hob cannot reach Hobwork, other hobs, secret values, or more of the house than it needs.
- **A malicious dependency.** Agents add npm packages to hobs. A package's code runs in workspace VMs (tests, dev servers, install scripts the hob allows), pipeline VMs (tests, build), the runtime VM (handlers) and the browser (hob UIs).

The principle for the larger items: the host never reads, writes or runs git on files a VM can write. That work moves into the VM, and the host takes back only data it can check.

Sections are in the order to work on them.

### Sandbox account

Gondolin's VFS provider runs in the host's Node process and QEMU is its child, both as the `hobwork` user that owns the data dir and `secret.key`. A VFS race or a QEMU escape is then a full compromise. Goal: neither can reach the data dir, `secret.key`, other hobs' files or the host process, on Linux production.

What Gondolin 0.12.0 does (read from its source):

- **QEMU is a client.** The host process listens on five Unix sockets (control, fs, ssh, ingress, and the `-netdev stream` socket) and QEMU connects to them (`-chardev socket,...,server=off`). QEMU never opens a mounted directory. It needs `/dev/kvm`, the kernel, the initrd, the root disk (a qcow2 overlay backed by the read-only `rootfs.ext4`) and those sockets.
- **The VFS is served over the fs socket** as length-prefixed CBOR messages (`fs_request`, `fs_response`). `FsRpcService` parses them in the host process and calls the providers (`RealFSProvider`, `ReadonlyProvider`, `ShadowProvider`) directly. `RealFSProvider` checks a path with `realpath` and then opens it, so a symlink the guest swaps in between the two escapes the mount. This is the VFS race.
- **Egress, secrets, `hobwork.internal`, the interceptor, ssh and ingress** are in the same Node process (the `-netdev` socket carries raw Ethernet frames that Gondolin's TypeScript network stack terminates). They hold secret values and must stay there. Guest-controlled parsing (TCP, DNS, HTTP, the exec protocol, the VFS protocol) therefore stays in the host process. This work does not protect against a bug in that parsing.

Design:

- **QEMU in its own namespaces** through `bwrap` (done, see Isolation under "Sandboxing (Gondolin)" in `docs/architecture.md`). It sees `/dev/kvm`, the guest image read-only and its VM directory, with no network, no host `/proc` and no data dir.
- **Fix the VFS race in the vendored Gondolin** instead of running the VFS in a separate process. `RealFSProvider` resolves a guest path one component at a time from an open directory handle: open the mount root, then open each component with `O_NOFOLLOW` (`O_DIRECTORY` for all but the last) relative to the previous handle, and run the operation (`open`, `mkdir`, `unlink`, `rename`, `symlink`, `link`, `stat`) on the last component relative to its parent's handle. Symlinks inside the mount that point inside the mount are followed by resolving their target the same way, from the mount root. Node has no `openat`, so on Linux the relative path is `/proc/self/fd/<dir fd>/<name>`, which the kernel resolves from the open directory, not from a path an attacker can swap. macOS has no such path; there the provider opens each component with `O_NOFOLLOW` by full path and checks the opened fd with `fstat` against the previous component's device and inode, which covers dev use.
- **Remove the VFS worker** (`server/src/sandbox/vfs-worker.ts`) once the fix is in, with the `virtiofs0` chardev rewrite in `qemu-namespaced.sh`, the empty `MemoryProvider`s and the `readGuestFile`/`writeGuestFile` path for isolated VMs. It costs about 100MB of host memory and 200ms of start time per VM, and the fix makes the race go away on every platform, not only on Linux with isolation on.
- **Separate accounts for QEMU, considered.** Another uid also stops same-uid `ptrace` and signals, but costs much more:
  - *`hobwork-vm@.service` template with `DynamicUser=yes`, started through polkit.* A rule allowing `org.freedesktop.systemd1.manage-units` for `hobwork-vm@*.service` (start and stop) lets the host start instances. It must not allow transient units (`systemd-run`): those let the caller pick `ExecStart` and `User=root`. Instance parameters go through a file in a per-instance dir, since the unit file fixes `ExecStart`. Hardening comes free: `PrivateNetwork=yes`, `RestrictAddressFamilies=AF_UNIX`, `DeviceAllow=/dev/kvm rw`, `MemoryMax`, `TasksMax`, `LimitCORE=0`, and the memory budget in "Resources" gets a cgroup to enforce it. Costs: QEMU is no longer Node's child, so Gondolin's `exit`, kill, stdout and stderr handling need a shim that starts and stops the unit, tails its log file and mirrors its exit status; polkit and D-Bus join the trust base.
  - *Small privileged launcher*: a socket-activated root service (`SocketUser=hobwork`, `SocketMode=0600`), one connection per VM. It forks QEMU under a chosen uid with seccomp and namespaces, streams stdio back, and kills the VM when the connection closes. It is new root code in Hobwork. Rejected unless namespaces prove insufficient.

Gondolin changes that would replace the shell shim `server/src/sandbox/qemu-namespaced.sh` and the deep imports in `server/src/sandbox/gondolin-internals.ts`:

- `sandbox.qemuArgs` (prepended arguments) and a `spawnQemu(path, args, options)` hook, so the host can add `-sandbox` and start QEMU in a namespace without a shell shim.
- `--version` is run on `qemuPath` before a VM starts, so the shim passes that through to plain QEMU.
- Socket file mode and dir options, so an account variant does not depend on `chmod` timing.

Phases:

1. **`-sandbox on`** (done): `HOBWORK_QEMU_SANDBOX=1` runs QEMU through `server/src/sandbox/qemu-sandboxed.sh`. A blocked syscall kills QEMU with SIGSYS (`audit: type=1326` in `dmesg`).
2. **QEMU in a namespace** (done). A host that asks for isolation and cannot create the namespaces refuses to start with the reason; there is no fallback to plain QEMU, since isolation that silently turns off is worse than none asked for.
3. **VFS race fixed in Gondolin, VFS worker removed.** Tests: a guest that swaps a directory for a symlink to outside the mount in a loop while another guest process opens, creates and renames files under it, for every operation above, on Linux and macOS.
4. **Accounts (optional)**: only if namespaces are unavailable or not enough.

Left before turning isolation on (`HOBWORK_SANDBOX_ISOLATION=namespaces`, off by default until then):

- **Turn it on in the `colossus` unit**: `pnpm -C server test:vm` passed there on 2026-09-30 with isolation on (with the VFS worker), and again with `HOBWORK_QEMU_SANDBOX=1` (KVM, `microvm`, `-cpu host`; no seccomp kills showed up). After phase 3, run the VM suite and `bench:sandbox` there again, set `RuntimeDirectory=hobwork` and `HOBWORK_SANDBOX_ISOLATION=namespaces` in the unit and start the host; its start check reports what the unit's hardening blocks.

Open questions:

- `hobwork.service` on `colossus` sets none of `SystemCallFilter`, `RestrictNamespaces`, `PrivateUsers` and `CapabilityBoundingSet` today, and unprivileged user namespaces are on (`user.max_user_namespaces` is 111565). Adding them later has to allow `unshare`, `mount`, `pivot_root` and user namespaces for `bwrap`.
- Is a kernel bug reachable from an unprivileged user namespace an acceptable remaining risk? A uid switch does not remove it either, so accounts only add same-uid `ptrace` and signal separation and protection against a bug in `bwrap` itself.
- Should `HOBWORK_QEMU_SANDBOX` default on for Linux, and should `qemu-system-$(uname -m)` follow the guest image manifest instead (Gondolin's own default picks by manifest arch)?

## Interrupting long-running work

Handlers get no signal when their invocation times out or is canceled. Pass an `AbortSignal` to handlers (`ctx.signal`) that fires on timeout or cancel, and honor it in the SDK's own calls: DB queries, `ctx.fetch`, `ctx.ha` and the AI helpers. Hob code passes it on to its own long-running work.

A hob DB query that runs longer than 30s is abandoned by terminating its worker, since SQLite cannot be interrupted from Node. Interrupt the query on abort instead once Node exposes a way to (SQLite's `sqlite3_interrupt` or a progress handler), so the connection survives.

## Home Assistant registry lookups in `ctx.ha`

`getStates` filters only by domain and entity IDs, so a hob that wants "the lights in the kitchen" or "everything labeled `vacation`" has to hard-code entity IDs, which break when someone renames or adds a device. Add registry filters to `getStates`: area, floor, label, device and integration, combined with the domain filter. The host resolves them to entity IDs from HA's entity, device, area, floor and label registries (it already reads the first three for the MCP HA tools in `server/src/homeassistant/client.ts`). An entity without its own area takes its device's area. Also add `getEntity(entityId)`, which returns its area, device, labels and name, and lists of areas, floors and labels, so a hob UI can offer them as choices.

No `render_template`: typed filters are easier for agents to get right than Jinja strings, and hobs compute anything else in TypeScript.

## Home Assistant integration

A custom HA integration (installed through HACS) that exposes Hobwork handlers as HA services or entities, so they can be used from the HA automation editor.

## OpenRouter

- Streaming responses from the OpenRouter helper. Gondolin now streams answers from its `onRequest` hook (patched), but the AI gateway reads the whole answer before returning it, to count usage. It has to pass the stream on through a transform that watches for the last server-sent event with `usage`, and record the cost when the stream ends (or is canceled, with the estimate from what was seen).
- A spend limit across all hobs, next to the per-hob ones.
- Check the vision model default (`google/gemini-3.1-flash-lite`) with an image request against OpenRouter. Only the gateway's model choice is tested.
- Decisions on a chat model (decision models off) answer `noul` as 0 or 1 without probabilities. Token log probabilities from providers that return them would give real ones.
- Check `reasoning: { enabled: false }` against OpenRouter with DeepSeek V4.1 Flash, which reasons by default, for decisions on a chat model.
- Spend limits can be passed by one request, since cost is known only afterwards. Estimating a request's cost from `max_tokens` and the model's prices before sending it would close that gap.
- Tell people when a hob reaches a limit (a notification to their devices), not only in the hob log.

## Push relay

APNs only accepts pushes to `dev.bgenc.hobwork` signed with a key of team 63QQLP356Q, so a self-hosted host cannot push to the TestFlight or App Store app, and the team key cannot be shared: it can push to every app of the team and cannot be revoked for one host. Until a relay exists the host sends no pushes (see Push in `docs/architecture.md`), so the iOS app only gets notifications and commands while it is open.

The relay and the app are trusted; hosts are not, since anyone can run one. A host can push only to devices whose app holds a pairing with it, never sees APNs tokens, and cannot choose the text a push shows before the app decrypts it. The relay cannot check a host's own records, so a host that removed a device can still push to it until the app revokes the grant or the grant expires.

### Relay

Built in `relay/` (Push relay in `docs/architecture.md`) and running at `relay.bgenc.dev`. Left:

- App Attest keys belong to the app's bundle ID, so the notification service extension probably cannot make assertions, and an attested registration then cannot renew grants from the extension. Check on a device; if so, renewals from the extension need another proof (for example the renewal push's grant list, signed by the relay).
- Check an attestation from a real device against the relay: the tests use their own CA, since Apple publishes no sample attestation.
- The App Store privacy label, from `relay/PRIVACY.md`.

### Push sidecar

- A small Rust process that holds the host's Ed25519 signing key and X25519 key. The private halves never leave it, and its storage is outside the data dir, so backups never contain them. It shares a crate with the relay for signing, compression, padding and encryption.
- On Linux it runs as its own user (systemd unit with `DynamicUser=yes` and `StateDirectory=hobwork-push`), reached over a socket unit with `SocketUser=hobwork`. On macOS in dev the host runs the same logic in-process.
- The host passes the sidecar's public keys to the app at pairing and in every `hello`, and asks the sidecar to send `(device, plaintext)`. When the key in `hello` changes, the app creates a new grant, which revokes the old one. A restored backup has no sidecar key, so the sidecar makes a new one and every app grants it on its next `hello`.
- A hob that is exploited but stays in its VM can push only through `ctx.device(...)` until it is disabled. Code that escapes into the host process as `hobwork` can push through the sidecar until the host restarts with the hole fixed, but cannot take the keys. Code that reaches root can take them, and grant expiry and the new grants after a reinstall bound that.

### Encryption

- The content key comes from an X25519 exchange between the app and the sidecar, so only they hold it. The payload carries a key ID so keys can rotate with pushes in flight.
- Encrypted: everything in `hobwork` today, plus title, body, `thread-id`, category, interruption level, sound, and a sent-at time and expiry. The plaintext is compressed with raw deflate (`zlib.deflateRawSync`, `COMPRESSION_ZLIB` in the app), padded to 256-byte buckets, and encrypted with ChaCha20-Poly1305 with the grant ID as associated data. About 2.9 KB of compressed plaintext fits in APNs' 4 KB; `too_large` checks the encrypted size.
- The notification service extension decrypts every push, rebuilds the notification, and handles actions and commands as today. Prompt pushes (NFC) become `mutable-content` too. It rejects pushes that fail to decrypt, are stale, or repeat one already seen, including one that came over the socket.
- The app's `willPresent` (`apple/Hobwork/Notifications/Notifier.swift`) returns no presentation options for a push whose ID the app already showed from the socket. Otherwise it shows a banner and plays the sound as the background would: passive notifications and updates only go to the list, and `sound: "none"` plays none.
- The relay and Apple still see the APNs token, which grants belong to one device, and the timing, size bucket, kind and priority of pushes.

### Configuration

- Host: `HOBWORK_PUSH_RELAY_URL`, defaulting to our relay, `off` to opt out, reported in `/.well-known/hobwork`. There is no direct APNs mode: someone with their own team runs their own relay.
- App: the relay URL is a build setting, and the app uses push only when the host's relay matches it, so a hostile host cannot point the app at a relay that collects tokens. Your own relay needs your own APNs key, so it always comes with your own app build.
- Upgrade: the host deletes the APNs tokens it has stored, and paired devices register with the relay on their next launch.

### Filtering entitlement

Hobwork does not use `com.apple.developer.usernotifications.filtering`. Apple grants it only for end-to-end encrypted messaging, earthquake warnings, education alerts and healthcare alert retraction, and Hobwork is none of these. The extension cannot hide a push, so:

- The ownership proof shows "Notifications from Hobwork are set up." once per registration.
- Renewal and notification withdrawals use background pushes.
- Pushes that fail to decrypt or are stale show generic fallback text, as does a notification whose extension crashed or timed out.
- A push that repeats one the app already got over the socket while open is hidden by the app's `willPresent` (see Encryption). When the app is not in the foreground with its socket open, as the Mac app often is, both show.

### Checks

- **macOS extension, first**: every relayed push needs the notification service extension to decrypt it. Apple documents it for macOS 10.14, but developer forum threads from 2019 to 2025 report it never being called on macOS, or killed for "sluggish startup", with no answer from Apple. Test it with a team-signed Mac build and a real APNs push before building the rest. If it does not run, Mac notifications show only the generic alert, and content still arrives over the socket, which the Mac app keeps open.
- On a real iPhone and Mac: ownership-proof and renewal push delivery. Only the socket paths have run on devices so far.

## Notifications

Left from sending to people, update, withdraw, scheduling and action routes (Notifications in `docs/architecture.md`):

- Deploy the relay with the `background` push kind. Until then the relay refuses withdrawals by push (`bad_request`), and a device off its socket removes a withdrawn notification only after its next `hello`.
- Check on real devices: that the extension's `interruptionLevel` and `sound` hold (time-sensitive through Focus, passive without waking the screen), that a background action tap wakes the app long enough to post the event, and how fast background withdrawal pushes arrive on a locked iPhone. "Within 5 s" holds for apps on their socket; background pushes are best effort and dropped after a force quit.
- An update by push shows a notification the person dismissed again (quietly), since the extension cannot drop a push. The socket path checks first.
- Updates go out as `passive`, so a time-sensitive notification loses its place at the top once updated.
- Named sounds: the app bundles none, so `sound` is `default` or `none`.
- The web UI and MCP tools show no pending scheduled notifications; only withdrawing by ID cancels one.
- Action routes run on the deployed version only; a notification sent from a branch preview cannot exist, since previews cannot use devices.

## People and callers

Left from `ctx.caller`, `ctx.people()` and per-person time zones (People and time zones in `docs/architecture.md`):

- Agents see no people: `list_devices` shows owner names, but no MCP tool lists people with their IDs and time zones, so an agent cannot look up the `Person.id` a hob keys data by.
- Route calls by agents (`/p/<hob>/api/...` with a token) get `caller: null`. A caller kind for agents would let hobs tell them apart from people.
- Requests of the app's web view to the Hobwork origin (the web UI, not a hob) do not count as device activity; only hob app origins, `hello` and user events do.
- The Devices section in Settings shows when a device was last seen, not when it was last used.
- The project page shows no next run for a per-person cron.

## Uploads

- `files.upload` resumes within one call. Resuming after a page reload (keeping the upload ID with the file's name, size and modification time in the web view's storage) is not built.
- Progress is reported per 8 MB part. Finer progress needs `XMLHttpRequest`, since `fetch` has no upload progress.
- Upload tokens work for the deployed version only. Branch previews take uploads from the app only.
- A token upload has no person. Tokens could carry one, so triggers know who dropped the file.

## Egress

- `get_hob` lists `egress` as written. It does not say which private targets the host allows, which the web UI shows; agents learn it from the `egress-blocked` log line.

## Web bridge

See Web bridge in `docs/architecture.md`.

- Tested in unit tests and in a web view with pages loaded under hob origins, not on a device: haptics, printing to an AirPrint printer (paper choice, `print(to:)` without the dialog, printer names from `contactPrinter`), the share sheet, the clipboard prompts and iPad popovers need a check on hardware.
- The app derives the apps host from the Hobwork host. A host with `HOBWORK_APPS_URL` somewhere else gets no bridge (nor in-app links). `/.well-known/hobwork` could name the apps host.
- Popovers point at the edge of the web view, not at the button. The page could send the button's rect, but a hob page in the web UI's iframe does not know its offset; the web UI could tell the app where the frame is.
- `clipboard.read` relies on the per-hob question and iOS's "Allow Paste" prompt, and the app does not check that a read follows a tap. `clipboard.paste` (a sheet with `UIPasteControl`) and `detect` avoid both prompts; the paste sheet is untested on a device.
- Local notifications have no actions. Actions that run without the app would need the host to know the notification; a hob can send through its own route instead.
- Printer and media lists: iOS has no API for them outside the picker and a print. macOS could list `NSPrinter.printerNames` and their papers.
- Permissions are per hob and shared with its branch previews. A preview with new code reads the clipboard if main was allowed.

## Camera

- Untested on hardware (unit tests with a fake camera only): `DataScannerViewController` with the page's symbologies, region and highlighting, `capturePhoto()` while scanning, the torch through `AVCaptureDevice` while VisionKit owns the capture session (VisionKit may switch it off when it reconfigures), the glass controls and the `UIImagePickerController` photo path.
- The page cannot draw over the viewfinder (the design's `ScannerOverlay`): that needs a transparent web view over a native preview layer and touches passed between them. Pages get a status pill and up to 3 buttons instead.
- No camera on Macs: VisionKit's data scanner is iOS only. A Mac could use `AVCaptureSession` with Vision barcode requests and Continuity Camera.
- A scan stays open when the page that started it navigates away; its events then reach no one, and the person closes it.
- Photos come back as base64 in the reply. A hob that wants many full-size photos would rather have the app upload them into a `files.upload` folder and answer with the path.

## NFC and alarms

- Untested on hardware (unit tests with fake sessions and a fake AlarmKit only): `NFCTagReaderSession` with NTAG21x, ISO 15693 and Type 4 tags (UIDs, read-back after write, `restartPolling` in sessions and how often a tag left on the reader is found again), the 60 second end of a session, the iPad to iPhone hand-off end to end, AlarmKit's repeat button with `.countdown` behavior, whether AlarmKit runs `secondaryIntent` for a `.countdown` button (if not, `repeated` comes only from `alarmUpdates` while the app runs), the stop and repeat intents launching the app in the background, and the Live Activity's subtitle, tint and repeat button.
- `alarms/fired` is only reported when the app sees the ring or a Stop/repeat; a timer that rings and is never stopped while the app is not running reports nothing until the app runs. AlarmKit gives apps no callback when an alarm fires.
- The alert's Stop button text ("Took them out") cannot be set on iOS 26.1 and later; the hob can put it in the title or subtitle.
- Hand-off only covers `nfc.read` and `nfc.write`; alarms ring on the device that set them, as the filament hob wants.
- `alarm-states.json` keeps one entry per alarm ID that ever rang; hobs that make new IDs for every timer grow it slowly.

## Share sheet and links to hob pages

See Share targets and Links to hob pages in `docs/architecture.md`.

- **Check on a device** (unit tests and the simulator so far; the simulator showed the extension in Safari's share sheet and its not-connected message): sharing a 200 MB 3MF from Files and a MakerWorld link from Safari to a paired host, the extension's memory while it uploads, and what iOS does when the person leaves the sheet half way. Universal links to hob pages need a signed build with `HOBWORK_APPLINKS_HOST` and an apps host that serves its association file: a tag with `https://<hob>.apps.<host>/spool/78` read in the background, the `link.opened` hand-off to an open page, an excluded path opening in the Safari view, and whether iOS's CDN reads the wildcard's file from the apps host as expected.
- **Uploads only while the sheet is open.** A background `URLSession` could send the parts after the sheet closes, but the route call after them needs code that runs; the app could take over (the extension hands the upload to the app group, a background session wakes the app on completion, and the app calls the route), at the cost of the `say` text never reaching the person except as a notification.
- **No "Open in Hobwork" after sharing.** Share extensions cannot open their app (`extensionContext.open` works only in widgets), so `ShareResult` has no `open`; the hob can send a notification that opens a page.
- **No share extension on the Mac.** macOS share extensions use the same activation rules with an AppKit view controller; the shared code (`Hobwork/Shared/Share/`) would carry over. The local signing (`just test-mac local`) has no app group, so the extension would not find the pairing there.
- **The paste control is a sheet.** `UIPasteControl` cannot sit in the page, so `clipboard.paste()` needs a second tap. A native toolbar above the web view with a paste button pages could turn on would save it.

## Live Activities, widgets and intents

See Live Activities and Widgets and intents in `docs/architecture.md`.

- **Deploy the relay** with activity tokens and the `liveactivity` push kind. Until then the relay refuses the token registrations and Live Activity pushes, and activities only start, update and end while the app is open on its socket (or from the bridge).
- **Check on a device** (only unit tests and the simulator so far): that ActivityKit decodes the sealed `content-state` and `attributes` through `HobworkActivityAttributes`' decoder in the widget extension (Apple documents no process for it; if the system decodes elsewhere, the content shows the placeholder and pushes have to carry plain content instead, which the relay and Apple could then read); push-to-start with `input-push-token`, and that iOS wakes the app to report the new activity's token; the real budget for priority 10 pushes and how late priority 5 ones arrive; the restart at 7 h 45 min ending the old activity and the "Still running" form after 8 hours; the button intent waking the app on a locked phone; background widget reload pushes.
- The progress budget is the host's guess (2 percentage points or 5 minutes). If iOS throttles anyway, the host could count priority 10 pushes per device and hour and fall back to 5.
- A device that dismissed an activity is skipped until the run ends. The app cannot tell a swipe from other ends on every iOS version (`ActivityState.dismissed` vs `.ended`); check which one a swipe reports.
- Activities started by push while the relay or the app's grant changes lose their update token (the relay keeps tokens per grant); they show their last content until they end.
- No Live Activities on Macs (ActivityKit is iOS only); the host never targets macOS devices.
- Widgets: no macOS widget extension, and the widget shows text, swatches and lines only (no charts or images). Widget reloads by background push are best effort.
- Intents: parameters are text, number or boolean, at most 4, asked one after another. Siri phrases name only the action entity, so "Hey Siri, where is spool 78" needs Siri keyword routing or Siri AI app schemas, which can run through `POST /api/devices/intents`; for now the person runs the action and Siri asks for the number.
- Agents cannot see Live Activities, widgets or intents of a hob in the MCP tools beyond `hobwork.json`; the web UI does not list running Live Activities.

## Share links

See Share links in `docs/architecture.md`.

- List a hob's share links on its page in the web UI (agent, branch, read-only, expiry), with revoking one. Today a link ends only when it expires or its credential, agent or hob goes away.
- Check the embedded view in clients other than Chromium-based ones. Safari's handling of partitioned cookies in third-party frames is untested; if it drops the cookie, the view should say so and offer "Open", which works first-party.
- Agents cannot see what the view shows. A screenshot or a text snapshot of the rendered page, taken in a browser on the host, would let agents check a UI change without a browser tool of their own.

## Shared UI components

There is no component library in core; hob UIs use the theme's Tailwind utilities. If agents keep rewriting the same components across hobs, ship them in the platform set.

## Siri

Hobs could be run by voice, for example "add milk to my shopping list" running the shopping list hob. Siri only runs App Intents of installed apps, so the app is the bridge. The app already has App Intents (`apple/Hobwork/Capabilities/NFC/NFCIntents.swift`). Device events (`POST /api/devices/events`) answer 204 and run triggers later, so Siri needs a new endpoint that runs a handler and returns what Siri says.

### Siri AI (iOS 27)

Researched October 2026 ([WWDC26 session 240](https://developer.apple.com/videos/play/wwdc2026/240/), [App schema domains](https://developer.apple.com/documentation/appintents/app-schema-domains)).

- Siri AI runs only App Intents that adopt an app schema from natural language. Plain App Intents still show up in Shortcuts, Spotlight and widgets, and App Shortcuts still work with their fixed phrases.
- The `.reminders` domain (iOS and macOS 27) fits list hobs. `@AppIntent(schema: .reminders.createReminder)` gets `title: String`, `list: ListEntity?`, `dueDate`, `note`, `tags` and more, and returns a `ReminderEntity`. The domain also has `createList`, `createSection`, `updateReminder` (complete, due date) and `deleteReminders`, and the entity schemas `list`, `reminder`, `section`.
- The app's `ListEntity` query would return lists that hobs declare. "Add milk to my shopping list in Hobwork" then arrives with `title = "milk"` and the shopping list hob's list, parsed by Siri. Other domains (Calendar, Notes, Clock) could map to hobs the same way. Actions that fit no domain cannot be one-shot with Siri AI.
- Unknown: whether the person has to name the app when Apple's Reminders app also adopts the domain. The docs do not say, and the session's demo names the app. Test on a device.
- Requirements ([How to get Siri AI](https://support.apple.com/en-us/127893)): iPhone 15 Pro or later, M1 Macs or later. Device and Siri language must match a supported language (English; French, Japanese, Korean, Portuguese and Spanish announced for October 2026). Not on iPhone, iPad or Apple Watch in the EU (Macs work), not with a mainland China Apple Account.

### Catch-all with keyword routing

Works on every device and language Siri supports. App Shortcut phrases cannot contain a `String` parameter, only `AppEntity` and `AppEnum` ones, so "ask Hobwork to add milk to the shopping list" cannot match in one turn. Leaving the `String` parameter out of the phrase makes Siri ask for it in a second turn and pass the answer through as text (the approach an Apple engineer gives in [this forum thread](https://developer.apple.com/forums/thread/832277)).

- "Ask Hobwork" → "What do you need?" → "add milk to the shopping list". The host routes the text by keyword.
- A `HobKeyword` entity in the phrase, `"\(\.$keyword) in \(.applicationName)"`, with values refreshed by `updateAppShortcutParameters()`: "Shopping list in Hobwork" → "What should I do?" → "add milk". Siri picks the hob before the text arrives. Keep the keyword set small and stable.

A hob declares keywords and one handler in `hobwork.json`:

```json
"voice": { "keywords": ["shopping list", "groceries"], "handler": "src/voice.ts" }
```

- The host matches keywords without starting a VM: lowercase, strip punctuation, tolerate plurals, match whole words, longest match wins. Then it invokes only that hob.
- The handler gets `{ text, keyword }`, parses what it can itself (`^add (.+?) to (my |the )?shopping list$`) and uses the AI gateway only when that fails. It returns `{ say }`, or `{ unhandled: true }`.
- No match, a keyword two hobs declare, or `unhandled`: either a router model call with the hobs' keywords and descriptions, or a spoken "No hob handles that". A setting picks which.
- A keyword conflict cannot fail one hob's merge because of another hob. The pipeline warns and the runtime falls back as above.
- Siri expects a quick answer. Host-side matching plus a cold runtime VM (about 0.7s on `colossus`) fits. A model fallback adds one to three seconds.

### Plan

1. The catch-all with both phrases: the `voice` entry in `hobwork.json` and its schema, a device endpoint that routes and returns `{ say }`, and the App Intent with the keyword entity.
2. The `.reminders` schema for list hobs, so Siri AI devices get one-shot "add milk to my shopping list". Needs a way for hobs to declare lists and handle create, update and delete.
