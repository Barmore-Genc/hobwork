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
- Decisions on a chat model (decision models off) answer `noul` as 0 or 1 without probabilities. Token log probabilities from providers that return them would give real ones.
- Check `reasoning: { enabled: false }` against OpenRouter with DeepSeek V4.1 Flash, which reasons by default, for decisions on a chat model.
- Spend limits can be passed by one request, since cost is known only afterwards. Estimating a request's cost from `max_tokens` and the model's prices before sending it would close that gap.
- Tell people when a hob reaches a limit (a notification to their devices), not only in the hob log.

## Push relay

APNs only accepts pushes to `dev.bgenc.hobwork` signed with a key of team 63QQLP356Q, so a self-hosted host cannot push to the TestFlight or App Store app, and the team key cannot be shared: it can push to every app of the team and cannot be revoked for one host. Until a relay exists the host sends no pushes (see Push in `docs/architecture.md`), so the iOS app only gets notifications and commands while it is open.

The relay and the app are trusted; hosts are not, since anyone can run one. A host can push only to devices whose app holds a pairing with it, never sees APNs tokens, and cannot choose the text a push shows before the app decrypts it. The relay cannot check a host's own records, so a host that removed a device can still push to it until the app revokes the grant or the grant expires.

### Relay

Built in `relay/` (Push relay in `docs/architecture.md`). Left:

- Start it at `relay.bgenc.dev`: the deploy is in place, and it needs the team's APNs key (`.p8`) and its ID, and the image package on GHCR made public (or the repo).
- App Attest keys belong to the app's bundle ID, so the notification service extension probably cannot make assertions, and an attested registration then cannot renew grants from the extension. Check on a device; if so, renewals from the extension need another proof (for example the renewal push's grant list, signed by the relay).
- Check an attestation from a real device against the relay: the tests use their own CA, since Apple publishes no sample attestation.
- `server/src/devices/apns.ts` is ported to `relay/src/apns.rs`; delete it from the host with the sidecar work.
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
- The app's `willPresent` (`apple/Hobwork/Notifications/Notifier.swift`) returns no presentation options for a push whose ID the app already showed from the socket. Today `willPresent` always returns `[.banner, .list, .sound]`.
- The relay and Apple still see the APNs token, which grants belong to one device, and the timing, size bucket, kind and priority of pushes.

### Configuration

- Host: `HOBWORK_PUSH_RELAY_URL`, defaulting to our relay, `off` to opt out, reported in `/.well-known/hobwork`. There is no direct APNs mode: someone with their own team runs their own relay.
- App: the relay URL is a build setting, and the app uses push only when the host's relay matches it, so a hostile host cannot point the app at a relay that collects tokens. Your own relay needs your own APNs key, so it always comes with your own app build.
- Upgrade: the host deletes the APNs tokens it has stored, and paired devices register with the relay on their next launch.

### Filtering entitlement

We are not applying for `com.apple.developer.usernotifications.filtering`. Apple grants it only for four use cases (end-to-end encrypted messaging, earthquake warnings, education alerts, healthcare alert retraction) and rejects other uses without a reason. Hobwork encrypts its pushes but is not a messaging app. Without the entitlement the extension cannot hide a push, so:

- The ownership proof shows "Notifications from Hobwork are set up." once per registration.
- Renewal uses background pushes.
- Pushes that fail to decrypt or are stale show generic fallback text, as does a notification whose extension crashed or timed out.
- A push that repeats one the app already got over the socket while open is hidden by the app's `willPresent` (see Encryption). When the app is not in the foreground with its socket open, as the Mac app often is, both show.

The relay keeps the `filtering` flag, so the entitlement can be added later if Apple widens it. It would then be requested for `dev.bgenc.hobwork.NotificationService` from the account owner's login, with provisioning profiles made by hand with "NSE Filtering" selected; to hide a notification the extension sets title, subtitle and body to empty strings.

### Checks

- **macOS extension, first**: every relayed push needs the notification service extension to decrypt it. Apple documents it for macOS 10.14, but developer forum threads from 2019 to 2025 report it never being called on macOS, or killed for "sluggish startup", with no answer from Apple. Test it with a team-signed Mac build and a real APNs push before building the rest. If it does not run, Mac notifications show only the generic alert, and content still arrives over the socket, which the Mac app keeps open.
- On a real iPhone and Mac: ownership-proof and renewal push delivery. Only the socket paths have run on devices so far.

## Share links

See Share links in `docs/architecture.md`.

- List a hob's share links on its page in the web UI (agent, branch, read-only, expiry), with revoking one. Today a link ends only when it expires or its credential, agent or hob goes away.
- Check the embedded view in clients other than Chromium-based ones. Safari's handling of partitioned cookies in third-party frames is untested; if it drops the cookie, the view should say so and offer "Open", which works first-party.
- Agents cannot see what the view shows. A screenshot or a text snapshot of the rendered page, taken in a browser on the host, would let agents check a UI change without a browser tool of their own.

## Shared UI components

There is no component library in core; hob UIs use the theme's Tailwind utilities. If agents keep rewriting the same components across hobs, ship them in the platform set.

## Screen Time without the Family Controls entitlement

Last resort if Apple rejects the Family Controls distribution entitlement. No third-party blocker (Opal, one sec, Jomo, Brick, AppBlock, Freedom, [Foqos](https://github.com/awaseem/foqos)) has a remote API; they run on the device with the same entitlement, and their only integration point is their Shortcuts actions (App Intents). The Hobwork app cannot call another app's intents, but it can open `shortcuts://run-shortcut?name=<name>`, which runs a Shortcut the person built around the blocker's actions (for example Foqos "Start session").

- The app still sends no `screenTime` capability. A new capability maps set names to Shortcut names the person enters in the app's settings, one to block and one to unblock.
- A call arriving while the app is in the foreground opens the Shortcut. Otherwise the host sends a notification, and tapping it opens the app, which opens the Shortcut. The notification service extension cannot open URLs, so this always needs a tap.
- Schedules and limits are left to the blocker app or to Shortcuts personal automations (time of day, Focus, NFC), which run without Hobwork. Hobwork only knows the state if the Shortcut reports it back, for example through a Hobwork App Intent it calls last.
