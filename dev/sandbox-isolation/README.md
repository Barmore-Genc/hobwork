# Sandbox isolation in Docker

Runs the Linux sandbox path (`HOBWORK_SANDBOX_ISOLATION=namespaces`: QEMU and the VFS worker under `bwrap`) against this checkout from a Mac or any Docker host. The container is Debian with Node 24, QEMU, `qemu-img` and bubblewrap, runs as an unprivileged user and uses QEMU's TCG, since Docker Desktop has no KVM. See "Sandboxing (Gondolin)" in `docs/architecture.md`.

`run.sh <command>` copies the checkout (without `node_modules`) into the container, installs dependencies for Linux (cached in the `hobwork-sandbox-isolation-pnpm` volume) and runs the command in the repo root. It needs a guest image for the Docker host's architecture (`images/build.sh`, or `HOBWORK_IMAGE_DIR`). The container is `--privileged` so its user can create user namespaces and mount `/proc` in them, which Docker's seccomp profile and masked `/proc` paths prevent otherwise.

```sh
dev/sandbox-isolation/run.sh pnpm -C server exec vitest run src/sandbox/isolation.test.ts src/sandbox/qemu.test.ts
HOBWORK_VM_TESTS=1 dev/sandbox-isolation/run.sh pnpm -C server exec vitest run src/sandbox/isolation.test.ts
dev/sandbox-isolation/run.sh pnpm -C server test:vm
dev/sandbox-isolation/run.sh pnpm -C server bench:sandbox vfs
HOBWORK_SANDBOX_ISOLATION=off dev/sandbox-isolation/run.sh pnpm -C server bench:sandbox vfs
```

`HOBWORK_SANDBOX_ISOLATION` (default `namespaces` here), `HOBWORK_QEMU_SANDBOX` and `HOBWORK_VM_TESTS` are passed through. Under TCG VMs boot in seconds and run much slower than with KVM, so timings are only comparable within one run of this container, and VM tests with tight timeouts can fail on time alone. Compare against the same suite with `HOBWORK_SANDBOX_ISOLATION=off`.

KVM, the `microvm` machine and `-cpu host` (x86_64 hosts) cannot be checked here. Run the VM suite with isolation on a Linux host with KVM before turning it on there.
