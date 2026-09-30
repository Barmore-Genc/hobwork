# TODO

## Security hardening

From the security audit of 2026-09-29. Two threats, in order of how they arrive:

- **A bug in agent-written hob code** that someone outside finds and exploits: a webhook or route that reflects input into HTML, XSS in a hob UI, an injection that runs code in the runtime VM, SSRF through a handler. The goal is that one buggy hob cannot reach Hobwork, other hobs, secret values, or more of the house than it needs.
- **A malicious dependency.** Agents add npm packages to hobs. A package's code runs in workspace VMs (tests, dev servers, install scripts the hob allows), pipeline VMs (tests, build), the runtime VM (handlers) and the browser (hob UIs).

The principle for the larger items: the host never reads, writes or runs git on files a VM can write. That work moves into the VM, and the host takes back only data it can check.

Sections are in the order to work on them.

### Guest privilege

- **Upstream `sandboxfs`**: the image patches Gondolin's `sandboxfs` (`allow_other`, files owned by uid 1000) and builds Gondolin's guest helpers from source with Zig. Make these options in our Gondolin patch or fork so the image patch can go.

### Sandbox account

Gondolin's VFS provider runs in the host's Node process and QEMU is its child, both as the `hobwork` user that owns the data dir and `secret.key`. A VFS race or a QEMU escape is then a full compromise. Goal: neither can reach the data dir, `secret.key`, other hobs' files or the host process, on Linux production. macOS dev keeps the in-process sandbox.

What Gondolin 0.12.0 does (read from its source):

- **QEMU is a client.** The host process listens on five Unix sockets in `os.tmpdir()` (control, fs, ssh, ingress, and the `-netdev stream` socket) and QEMU connects to them (`-chardev socket,...,server=off`). QEMU never opens a mounted directory. It needs `/dev/kvm`, the kernel, the initrd, the root disk (a qcow2 overlay the host creates in `os.tmpdir()` with `qemu-img`, backed by the read-only `rootfs.ext4`) and those sockets.
- **The VFS is served over the fs socket** as length-prefixed CBOR messages (`fs_request`, `fs_response`). `FsRpcService` parses them in the host process and calls the providers (`RealFSProvider`, `ReadonlyProvider`, `ShadowProvider`) directly. `RealFSProvider` checks a path with `realpath` and then opens it, so a symlink the guest swaps in between the two escapes the mount. This is the VFS race.
- **Egress, secrets, `hobwork.internal`, the interceptor, ssh and ingress** are in the same Node process (the `-netdev` socket carries raw Ethernet frames that Gondolin's TypeScript network stack terminates). They hold secret values and must stay there. Guest-controlled parsing (TCP, DNS, HTTP, the exec protocol) therefore stays in the host process whatever we do here. This work takes the VFS and QEMU out of the host process. It does not protect against a bug in the network stack.
- **Command line**: Gondolin builds the whole QEMU command line (`buildQemuArgs`) and has no extra-args option. The binary is settable (`sandbox.qemuPath`), as are the socket paths, `rootDiskPath` (with `rootDiskDeleteOnClose`), `machineType`, `accel` and `cpu`. It spawns QEMU with `stdio: ['ignore', 'pipe', 'pipe']` and relies on the child's `exit` event and SIGTERM/SIGKILL. `FsRpcService`, `RealFSProvider`, `ReadonlyProvider` and `ShadowProvider` are exported. `MountRouterProvider` and the frame codec are not (`exports` allows only the package root).
- **Node cannot pass file descriptors** over a Unix socket (no `SCM_RIGHTS`), only to children it spawns. Handing mounted directories to a process under another account as open fds would need a non-Node helper. A worker that opens the paths itself is simpler.

Design:

- **Two extra processes per VM.** A QEMU process and a VFS worker (`node` running `FsRpcService` over the mounts of that one VM). The host process keeps the network stack, control channel and secrets, and listens on the control, ssh, ingress and net sockets as today. The worker listens on the fs socket. QEMU connects to all five.
- **Containment by unprivileged namespaces, not accounts (recommended).** Each process starts through `bwrap` (bubblewrap) as the `hobwork` user, which works under `NoNewPrivileges=yes` when the kernel allows unprivileged user namespaces. Flags: `--unshare-all --die-with-parent --new-session --cap-drop ALL`, a tmpfs root, and only what the process needs bound in.
  - QEMU sees `/dev/kvm`, the kernel, initrd and rootfs (read-only), its overlay and the per-VM socket dir. It has no network (a Unix socket in a bound dir still works), no host `/proc` and no data dir. `-sandbox on` stays on inside.
  - The worker sees node and the release tree read-only, its socket dir, and only the mount dirs of its VM (one workspace's `files/`, or one build). A swapped-in symlink resolves inside that namespace, so `/var/lib/hobwork/secret.key` or another hob's workspace do not exist for it. This fixes the VFS race by construction and separates hobs without per-hob accounts.
  - Nothing changes in file ownership: the data dir stays `700` and owned by `hobwork`, nothing moves, nothing needs migrating. The overlay, sockets and mounts work because the uid is the same.
- **Separate accounts, considered.** Another uid also stops same-uid `ptrace` and signals and adds DAC separation, but costs much more:
  - *`hobwork-vm@.service` template with `DynamicUser=yes`, started through polkit.* A rule allowing `org.freedesktop.systemd1.manage-units` for `hobwork-vm@*.service` (start and stop) lets the host start instances. It must not allow transient units (`systemd-run`): those let the caller pick `ExecStart` and `User=root`. Instance parameters go through a file in a per-instance dir, since the unit file fixes `ExecStart`. Per-instance isolation without knowing the dynamic uid: `BindPaths=/run/hobwork/vm/%i` with `TemporaryFileSystem=/run/hobwork`. Hardening comes free: `PrivateNetwork=yes`, `RestrictAddressFamilies=AF_UNIX`, `DeviceAllow=/dev/kvm rw`, `MemoryMax`, `TasksMax`, `LimitCORE=0`, and the memory budget in "Resources" gets a cgroup to enforce it. Costs: QEMU is no longer Node's child, so Gondolin's `exit`, kill, stdout and stderr handling need a shim that starts and stops the unit, tails its log file and mirrors its exit status; a template instance may not be a valid dynamic user name (check); polkit and D-Bus join the trust base; `hostPid()` points at the shim.
  - *Small privileged launcher*: a socket-activated root service (`SocketUser=hobwork`, `SocketMode=0600`), one connection per VM. It forks QEMU under a chosen uid with seccomp and namespaces, streams stdio back, and kills the VM when the connection closes. It gives Gondolin child-like semantics, but it is new root code in Hobwork. Rejected unless namespaces prove insufficient.
  - *File ownership for either.* The worker's uid must be stable because workspaces persist between VM runs, so `DynamicUser` (uid released on stop) fits QEMU but not the worker. Use a pool of static accounts (`systemd-sysusers`, for example 64 named `hobwork-sb-N`, hob to slot in the host DB, sharing when hobs outnumber slots) and POSIX default ACLs so `hobwork` and the slot's account can both read and write new files. The mount dirs (`workspaces/`, `builds/`) must leave the `700` data dir, for example `/var/lib/hobwork-vm/<hob>/` with `/var/lib/hobwork-vm` at `711`. Existing workspaces and builds move once on upgrade (builds can be dropped, they are rebuilt on demand).
- **Order against "Nothing on the host touches guest-writable files".** That section moves file tools, git and migrations into the VM, so the host stops reading workspace files. Doing it first makes the account variant simpler, since the host then needs no access to the workspace dir. The namespace variant does not depend on it.

Gondolin changes. Phases 1 to 3 work without any, through `server/src/sandbox/qemu-namespaced.sh` and the deep imports in `server/src/sandbox/gondolin-internals.ts`. These changes, in our Gondolin patch or a fork, would replace them:

- `sandbox.qemuArgs` (prepended arguments) and a `spawnQemu(path, args, options)` hook, so the host can add `-sandbox` and start QEMU in a namespace without a shell shim.
- `vfs.external` (or a `virtioFsSocketPath` the server does not listen on): `SandboxServer` does not open the fs bridge, and the mount list still reaches the guest. Today `VirtioBridge.connect()` unlinks and listens on that path, which would replace the worker's socket. The shim instead rewrites the `virtiofs0` chardev path (the host's own fs bridge listens on an unused path outside QEMU's namespace) and the host passes empty `MemoryProvider`s for the mounts, so the guest gets the right `sandboxfs.bind=` list.
- Export `MountRouterProvider`, `normalizeMountMap` and a `serveVfs({ mounts, socketPath })` helper for the worker, and the MITM CA certificate loader. Without them the worker imports `vfs/mounts.js`, `sandbox/virtio-protocol.js`, `vfs/linux-errno.js` and `mitm.js` by file path, which only works because the version is pinned (the wrapper refuses other versions).
- A way for `VM.fs` to skip its host-side VFS shortcut. With isolation, `Sandbox.readFile` and `writeFile` call the private server's `readGuestFile` and `writeGuestFile`.
- `--version` is run on `qemuPath` before a VM starts, so the shim passes that through to plain QEMU.
- Socket file mode and dir options, so an account variant does not depend on `chmod` timing.

Phases:

1. **`-sandbox on`** (done): `HOBWORK_QEMU_SANDBOX=1` runs QEMU through `server/src/sandbox/qemu-sandboxed.sh`. Run `HOBWORK_QEMU_SANDBOX=1 pnpm -C server test:vm` on `colossus`, set it in the unit, later make it the default on Linux. A blocked syscall kills QEMU with SIGSYS (`audit: type=1326` in `dmesg`).
2. **QEMU in a namespace** (done): see Isolation under "Sandboxing (Gondolin)" in `docs/architecture.md`. A host that asks for isolation and cannot create the namespaces refuses to start with the reason; there is no fallback to plain QEMU, since isolation that silently turns off is worse than none asked for.
3. **VFS worker** (done): one worker per VM (simplest, and it separates a workspace VM from a pipeline VM of the same hob). Tests and the Docker setup in `dev/sandbox-isolation/`.
4. **Accounts (optional)**: only if namespaces are unavailable or not enough. 4 to 5 days for the template, polkit rule, shim, account pool, ACLs and the data move.

Left before turning isolation on (`HOBWORK_SANDBOX_ISOLATION=namespaces`, off by default until then):

- **Run it on `colossus`**: bubblewrap 0.13.0 is installed. Set `RuntimeDirectory=hobwork` and `HOBWORK_SANDBOX_ISOLATION=namespaces` in the unit, start the host (the start check reports what is missing), then run `HOBWORK_SANDBOX_ISOLATION=namespaces pnpm -C server test:vm` (it includes `isolation.test.ts`), again with `HOBWORK_QEMU_SANDBOX=1`, and `bench:sandbox` with isolation off and on. Only a KVM host shows whether QEMU under `bwrap` needs more than `/dev/kvm` for `-accel kvm`, `microvm` and `-cpu host` (for example `/sys/devices/system/cpu` read-only, which `qemuBwrapArgs` would then bind). So far the isolation tests have only run in Docker on a Mac under emulation, with the `virt` machine.
- **Memory budget**: every isolated VM adds a Node process (about 100MB RSS, 60MB of it Node itself; loading only the VFS modules of Gondolin saves 6MB) and two small `bwrap` processes. The VM budget in "Resources" counts only guest memory. `hostPid()` returns the outer `bwrap`, so accounting has to read the cgroup or the process tree.
- **QEMU outside `/usr`**: QEMU's namespace binds only `/usr` and the library directories, so a QEMU installed elsewhere (Nix, `/opt`) does not start. Bind the directory of `qemu-system-*` found on `PATH` if a host needs it.

Open questions:

- What does `hobwork.service` set for `SystemCallFilter`, `RestrictNamespaces`, `PrivateUsers` and `CapabilityBoundingSet`? `bwrap` needs `unshare`, `mount`, `pivot_root` and user namespaces, so a strict filter has to allow them. Are unprivileged user namespaces enabled there (`user.max_user_namespaces`)? The start check answers both.
- Does `-sandbox on` with `spawn=deny` and `resourcecontrol=deny` hold with KVM, `microvm` and `-cpu host` on `colossus`, in and out of the namespace?
- Is a kernel bug reachable from an unprivileged user namespace an acceptable remaining risk? A uid switch does not remove it either, so accounts only add same-uid `ptrace` and signal separation and protection against a bug in `bwrap` itself.
- Should `HOBWORK_QEMU_SANDBOX` default on for Linux, and should `qemu-system-$(uname -m)` follow the guest image manifest instead (Gondolin's own default picks by manifest arch)?

### Smaller items

- `GondolinSandbox.exited` listens on the VM's private `server` for its exit; add a public exit event to our Gondolin patch (with the other Gondolin changes under Sandbox account).

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

- Streaming responses from the OpenRouter helper. Gondolin now streams answers from its `onRequest` hook (patched), but the AI gateway reads the whole answer before returning it, to count usage. It has to pass the stream on through a transform that watches for the last server-sent event with `usage`, and record the cost when the stream ends (or is canceled, with the estimate from what was seen).
- A spend limit across all hobs, next to the per-hob ones.
- Decisions on a chat model (decision models off) answer `noul` as 0 or 1 without probabilities. Token log probabilities from providers that return them would give real ones.
- Check `reasoning: { enabled: false }` against OpenRouter with DeepSeek V4.1 Flash, which reasons by default, for decisions on a chat model.
- Spend limits can be passed by one request, since cost is known only afterwards. Estimating a request's cost from `max_tokens` and the model's prices before sending it would close that gap.
- Tell people when a hob reaches a limit (a notification to their devices), not only in the hob log.

## Push relay

APNs only accepts pushes to `dev.bgenc.hobwork` signed with a key of team 63QQLP356Q, so a self-hosted host cannot push to the TestFlight or App Store app, and the team key cannot be shared: it can push to every app of the team and cannot be revoked for one host. Until a relay exists the host sends no pushes (see Push in `docs/architecture.md`), so the iOS app only gets notifications and commands while it is open.

Plan: a small relay service that holds the key, run by the app's publisher.

- **Registration**: the app sends its APNs token and environment to the relay and gets an opaque relay token for that device and host. It sends the relay token in `hello` and `PUT /api/devices/push` instead of the APNs token.
- **Sending**: the host posts the push (headers it sets today: push type, priority, `apns-id`, collapse ID, expiration) with the relay token to the relay, which forwards it to APNs and answers with APNs' status. Tokens APNs reports as gone are answered the same way as today, so the host forgets them.
- **End-to-end encryption**: the relay sees notification titles, bodies and command arguments otherwise. At pairing, the app and host agree on a key (sent with the device token exchange, kept in the app group's keychain). The host encrypts the `hobwork` part and the alert text; the push carries only a generic alert and `mutable-content: 1`, and the notification service extension decrypts and shows the real text or runs the command. Every push then goes through the extension, which already handles actions and command pushes.
- **Abuse**: rate limits per relay token and per sending host, a size limit matching APNs' 4 KB, and hosts registering with the relay (a key per host) so one host can be cut off.
- **Own key**: a host whose owner builds the app with their own team keeps pushing to APNs directly with `HOBWORK_APNS_KEY_FILE`, `HOBWORK_APNS_KEY_ID`, `HOBWORK_APNS_TEAM_ID` and a topic setting, which come back with the relay.
- Check APNs delivery end to end on a real iPhone and on a Mac with a team-signed build once pushes are on again. Only the socket paths have run on devices so far.

## Shared UI components

There is no component library in core; hob UIs use the theme's Tailwind utilities. If agents keep rewriting the same components across hobs, ship them in the platform set.

## Screen Time without the Family Controls entitlement

Last resort if Apple rejects the Family Controls distribution entitlement. No third-party blocker (Opal, one sec, Jomo, Brick, AppBlock, Freedom, [Foqos](https://github.com/awaseem/foqos)) has a remote API; they run on the device with the same entitlement, and their only integration point is their Shortcuts actions (App Intents). The Hobwork app cannot call another app's intents, but it can open `shortcuts://run-shortcut?name=<name>`, which runs a Shortcut the person built around the blocker's actions (for example Foqos "Start session").

- The app still sends no `screenTime` capability. A new capability maps set names to Shortcut names the person enters in the app's settings, one to block and one to unblock.
- A call arriving while the app is in the foreground opens the Shortcut. Otherwise the host sends a notification, and tapping it opens the app, which opens the Shortcut. The notification service extension cannot open URLs, so this always needs a tap.
- Schedules and limits are left to the blocker app or to Shortcuts personal automations (time of day, Focus, NFC), which run without Hobwork. Hobwork only knows the state if the Shortcut reports it back, for example through a Hobwork App Intent it calls last.
