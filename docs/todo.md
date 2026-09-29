# TODO

## Security hardening

From the security audit of 2026-09-29. Two threats, in order of how they arrive:

- **A bug in agent-written hob code** that someone outside finds and exploits: a webhook or route that reflects input into HTML, XSS in a hob UI, an injection that runs code in the runtime VM, SSRF through a handler. The goal is that one buggy hob cannot reach Hobwork, other hobs, secret values, or more of the house than it needs.
- **A malicious dependency.** Agents add npm packages to hobs. A package's code runs in workspace VMs (tests, dev servers, install scripts the hob allows), pipeline VMs (tests, build), the runtime VM (handlers) and the browser (hob UIs).

The principle for the larger items: the host never reads, writes or runs git on files a VM can write. That work moves into the VM, and the host takes back only data it can check.

Sections are in the order to work on them.

### Limiting a compromised hob

- **Default CSP for hob UIs**: app origins serve hob UIs and route responses with a strict CSP (`script-src 'self'`, no inline scripts, `object-src 'none'`, `base-uri 'none'`) and `nosniff`, so most XSS bugs in agent-written UIs cannot run script. `hobwork.json` can loosen it for a hob that needs to.

### Supply chain

- **Install script changes in the UI**: a merge that changes `allowBuilds` gets a notice in its pipeline output. The web UI has no version diff to show it in; add one, or a flag on the version in `list_versions` and the versions list.

### Nothing on the host touches guest-writable files

- **Workspace git in the VM**: `commit`, `diff` and `changes` run git inside the workspace VM, and a commit reaches the bare repo by pushing over git smart HTTP through `hobwork.internal` with the session token. The pre-receive hook already refuses `main`. Today a nested repo's config (`core.fsmonitor`, filter drivers) runs on the host during `git add` and `git status`; in the VM, submodule recursion keeps working and runs where workspace code already runs.
- **Migration disk quota**: a migration can fill the host disk through its `/migrate` mount; only the DB it returns is size-checked. Put a quota on the mount or check the dir's size while the VM runs.
- **File tools in the VM**: `read_file`, `write_file`, `edit_file`, `delete_file`, `list_files` and `search` run inside the workspace VM. The host's check-then-open on the checkout races with symlinks the guest swaps in. Needs the workspace VM running for reads, so it depends on the VM budget below.
- **Build copy after the VM stops**: stop the pipeline VM before `saveBuild`, and copy with `O_NOFOLLOW`.

### Home Assistant, AI and secrets


### Resources


### Guest privilege

Everything in a workspace VM runs as root, so any process (a dependency's install script, a test) can read the agent's `HOBWORK_SESSION` from `/proc` and merge. Run agent commands as an unprivileged guest user, keep the session token in a root-owned helper that only the `hobwork` CLI reaches, and set `kernel.yama.ptrace_scope` to 1 and `hidepid=2` on `/proc`. Needs an image rebuild.

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

Gondolin changes. Phases 1 to 3 need none if we accept a wrapper and one deep import. An upstream PR would replace the wrappers:

- `sandbox.qemuArgs` (prepended arguments) and a `spawnQemu(path, args, options)` hook, so the host can add `-sandbox` and start QEMU in a namespace without a shell shim.
- `vfs.external` (or a `virtioFsSocketPath` the server does not listen on): `SandboxServer` does not open the fs bridge, and the mount list still reaches the guest. Today `VirtioBridge.connect()` unlinks and listens on that path, which would replace the worker's socket. The wrapper instead rewrites the `virtiofs0` chardev path in the QEMU shim (the host's own fs bridge listens on an unused path and never gets a connection) and passes empty `MemoryProvider`s for the mounts, so the guest gets the right `sandboxfs.bind=` list.
- Export `MountRouterProvider` and a `serveVfs({ mounts, socketPath })` helper for the worker. Without them the worker imports `dist/src/vfs/mounts.js` and `virtio-protocol.js` by file path (works because the version is pinned) and needs `cbor2` as a direct dependency. The MITM CA mount (`/etc/gondolin/mitm`, certificate only) has to be recreated in the worker.
- Socket file mode and dir options, so an account variant does not depend on `chmod` timing.

Details of the namespace variant:

- **QEMU shim**: `qemuPath` points at a script that receives Gondolin's arguments, rewrites the fs chardev path and `exec`s `bwrap ... qemu-system-$(uname -m) -sandbox on,... "$@"`. The overlay and sockets live in a per-VM dir under `/run/hobwork` (`rootDiskPath` with `rootDiskDeleteOnClose`, and the `*SocketPath` options) instead of `os.tmpdir()`, so each namespace binds only its own VM's dir.
- **Worker**: started by the host before `vm.start()`, with the mount list as JSON on stdin (guest path, host path, `readonly`, `hide`, `vmDisk`). It listens on the fs socket and exits when the socket or the host closes. The host waits for its readiness line before starting QEMU. If the worker dies the VM's mounts fail with `EIO` and the host stops the VM.
- **`-sandbox on`**: `on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny` (libvirt's set). Alpine's QEMU accepted them and booted the guest kernel under TCG in Docker. Not yet run with KVM and `microvm` on `colossus`. A blocked syscall kills QEMU with SIGSYS (`audit: type=1326` in `dmesg`), so the VM suite has to pass with `HOBWORK_QEMU_SANDBOX=1` before it becomes the default.
- **macOS**: QEMU there has no seccomp and there is no `bwrap`. `qemu.ts` returns the default binary and the VFS stays in-process. The `Sandbox` interface does not change, so `test-sandbox.ts` and all callers are untouched. Linux isolation sits behind one switch (`HOBWORK_SANDBOX_ISOLATION`, `namespaces` or `off`).
- **Speed**: the guest talks to the worker directly and the host is out of the fs path, so file operations should cost what they do today. Measure `bench:sandbox vfs` before and after, since the fs channel is already the slow part (see `vmDisk`).
- **Kill and accounting**: `bwrap --die-with-parent` with a PID namespace ends QEMU when the shim is killed, so Gondolin's SIGTERM/SIGKILL and `exit` handling keep working. `hostPid()` returns the shim's PID, which is `bwrap` and not QEMU. Nothing uses it yet. The memory budget in "Resources" must read the cgroup or the process tree.

Phases:

1. **`-sandbox on`** (done): `HOBWORK_QEMU_SANDBOX=1` runs QEMU through `server/src/sandbox/qemu-sandboxed.sh`. Run `HOBWORK_QEMU_SANDBOX=1 pnpm -C server test:vm` on `colossus`, set it in the unit, later make it the default on Linux. About half a day.
2. **QEMU in a namespace**: `bwrap` shim, per-VM runtime dir for sockets and overlay, a start-time check that unprivileged user namespaces work (clear error, or fall back to plain QEMU). 2 to 3 days including a test on `colossus` that a process in the QEMU namespace cannot read the data dir.
3. **VFS worker**: worker, mount provider construction shared with the in-process path, `bwrap` for it, a symlink race test (the guest swaps a symlink to a file outside the mount while reading and must never see it), VM suite, benchmark. 4 to 6 days with the deep-import wrapper, plus the upstream PR (about 2 days of ours, review time not ours).
4. **Accounts (optional)**: only if namespaces are unavailable or not enough. 4 to 5 days for the template, polkit rule, shim, account pool, ACLs and the data move.

Open questions:

- Is `bubblewrap` on `colossus`, and are unprivileged user namespaces enabled (`kernel.unprivileged_userns_clone`, `user.max_user_namespaces`)? Installing it needs approval. `unshare` from `util-linux` with a small `pivot_root` script needs no new package but is more code to get right.
- What does `hobwork.service` set for `SystemCallFilter`, `RestrictNamespaces`, `PrivateUsers` and `CapabilityBoundingSet`? `bwrap` needs `unshare`, `mount`, `pivot_root` and user namespaces, so a strict filter has to allow them.
- Does `-sandbox on` with `spawn=deny` and `resourcecontrol=deny` hold with KVM, `microvm` and `-cpu host` on `colossus`?
- Is a kernel bug reachable from an unprivileged user namespace an acceptable remaining risk? A uid switch does not remove it either, so accounts only add same-uid `ptrace` and signal separation and protection against a bug in `bwrap` itself.
- One VFS worker per VM or per hob? Per VM is simplest and separates a workspace VM from a pipeline VM of the same hob. Per hob saves Node processes (about 40MB each) but shares one namespace across a hob's VMs.
- Will upstream take `qemuArgs`, `spawnQemu` and `vfs.external`, and when? Until then the wrappers depend on the pinned 0.12.0 internals.
- Should `HOBWORK_QEMU_SANDBOX` default on for Linux, and should `qemu-system-$(uname -m)` follow the guest image manifest instead (Gondolin's own default picks by manifest arch)?

### Smaller items

- Migration VMs reserve from the VM budget as pipeline VMs of no hob; pass the hob so fair shares count them.
- A VM that exits on its own keeps its budget reservation until `stop()` runs; release it from an exit event in the Gondolin wrapper.
- Read-only tools read from git instead of opening a workspace.

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
