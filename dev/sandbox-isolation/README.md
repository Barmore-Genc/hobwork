# Sandbox isolation in Docker

Runs the Linux sandbox path (`HOBWORK_SANDBOX_ISOLATION=namespaces`: QEMU and the VFS worker under `bwrap`) against this checkout on a Linux Docker host with KVM. The container is Debian with Node 24, QEMU, `qemu-img` and bubblewrap, runs as an unprivileged user and gets the host's `/dev/kvm`. `run.sh` refuses to run without `/dev/kvm`: under QEMU emulation (TCG) the VM suite takes hours, so Docker Desktop on a Mac cannot run it. See "Sandboxing (Gondolin)" in `docs/architecture.md`.

`run.sh <command>` copies the checkout (without `node_modules`) into the container, installs dependencies for Linux (cached in the `hobwork-sandbox-isolation-pnpm` volume) and runs the command in the repo root. It needs a guest image for the Docker host's architecture (`images/build.sh`, or `HOBWORK_IMAGE_DIR`). The container is `--privileged` so its user can create user namespaces and mount `/proc` in them, which Docker's seccomp profile and masked `/proc` paths prevent otherwise.

```sh
dev/sandbox-isolation/run.sh pnpm -C server exec vitest run src/sandbox/isolation.test.ts src/sandbox/qemu.test.ts
HOBWORK_VM_TESTS=1 dev/sandbox-isolation/run.sh pnpm -C server exec vitest run src/sandbox/isolation.test.ts
dev/sandbox-isolation/run.sh pnpm -C server test:vm
dev/sandbox-isolation/run.sh pnpm -C server bench:sandbox vfs
HOBWORK_SANDBOX_ISOLATION=off dev/sandbox-isolation/run.sh pnpm -C server bench:sandbox vfs
```

`HOBWORK_SANDBOX_ISOLATION` (default `namespaces` here), `HOBWORK_QEMU_SANDBOX` and `HOBWORK_VM_TESTS` are passed through. Compare against the same suite with `HOBWORK_SANDBOX_ISOLATION=off`.
