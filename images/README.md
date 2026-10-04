# Guest image

`hobwork.json` is a [Gondolin build config](https://github.com/earendil-works/gondolin/blob/main/docs/custom-images.md): Alpine, Node with the full ICU data (`build.sh` copies it in, since the builder would install only English), npm, pnpm, git, curl, tzdata, doas and su-exec (see below), e2fsprogs (`resize2fs` is needed to grow the root disk), Python 3 for ad-hoc scripts (standard library only: there is no pip, and `ensurepip` with its bundled pip wheel is deleted, so neither `python3 -m ensurepip` nor `python3 -m venv` installs one), the platform dependency set from `platform/` installed at `/opt/hobwork/platform`, plus `@hobwork/sdk` copied from `packages/sdk` into its `node_modules`, and Inter with `fonts/fonts.conf` in `/opt/hobwork/fonts` for the letter of default hob icons (`build.sh` copies only `InterVariable.ttf` out of Alpine's `font-inter`).

The image has an unprivileged `agent` user (uid and gid 1000). The host runs hob code as that user (`server/src/guest-vm.ts`), and `/etc/doas.conf` lets it run only `/usr/local/bin/hobwork-broker` as root without a password. The host writes that script at VM start. It is the helper that holds session tokens for the `hobwork` CLI. See "Guest privilege" in `docs/architecture.md`.

The guest helpers come from the vendored Gondolin (`vendor/gondolin/dist/guest`), whose `sandboxfs` mounts the VM's host directories with FUSE's `allow_other` and reports uid and gid 1000 for every file, so the `agent` user can use them. `build.sh` builds all four helpers from those sources with a pinned Zig release (0.16.0, checked by SHA-256) and `hobwork.json` points to them (`sandboxdPath` and the others). The image builder is the vendored Gondolin's too.

## Building

```sh
images/build.sh
```

This needs only Docker (and network access to `ziglang.org` for the Zig download). It builds for the machine's architecture in a privileged `node:24-alpine` container (the build chroots into the rootfs and mounts `/proc` there) with the vendored Gondolin, and writes the image to `images/build/<arch>/`. The host finds it there, or at `HOBWORK_IMAGE_DIR`.

Rebuild after changing `hobwork.json`, the platform set or `packages/sdk`. The container mounts the whole repo because of `packages/sdk`.

## Changing the platform set

Edit `platform/package.json` (exact versions only), then update the lockfile:

```sh
pnpm -C images/platform install --lockfile-only --ignore-workspace
```

## On hobwork-host (x86_64 Linux)

Needs `qemu-system-x86_64`, `qemu-img`, Node >= 23.6 and read-write access to `/dev/kvm`. hobwork-host has no pnpm and no Docker access for the user, so build on another machine with Docker and copy the result over. From the repo root on the Mac (the `--platform` flags make Docker emulate x86_64):

```sh
HOBWORK_IMAGE_ARCH=x86_64 images/build.sh

# linux-x64 node_modules (Gondolin optional dependencies are per platform)
docker run --rm --platform linux/amd64 -v "$PWD:/repo" -w /repo node:26 \
  sh -euc 'npm i -g pnpm@12.5.1 && pnpm install --frozen-lockfile'

rsync -a --exclude .git --exclude /data ./ hobwork-host:hobwork-bench/
```

Do this from a scratch copy of the repo, not the working checkout, because it replaces the Mac `node_modules`. Then run on hobwork-host with the host's Node:

```sh
cd ~/hobwork-bench/server
export HOBWORK_IMAGE_DIR=$HOME/hobwork-bench/images/build/x86_64
HOBWORK_VM_TESTS=1 node node_modules/vitest/vitest.mjs run src/sandbox src/guest-vm src/runtime/runtime.vm src/ssh/ssh.vm
node scripts/bench-sandbox.ts vm
node scripts/bench-sandbox.ts vfs
```

Once the user has Docker access on hobwork-host, `pnpm install`, `images/build.sh` and the `pnpm -C server` commands work there directly.
