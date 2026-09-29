# Guest image

`hobwork.json` is a [Gondolin build config](https://github.com/earendil-works/gondolin/blob/main/docs/custom-images.md): Alpine, Node, npm, pnpm, git, curl, e2fsprogs (`resize2fs` is needed to grow the root disk), and the platform dependency set from `platform/` installed at `/opt/hobwork/platform`, plus `@hobwork/sdk` copied from `packages/sdk` into its `node_modules`.

## Building

```sh
images/build.sh
```

This needs only Docker. It builds for the machine's architecture in a privileged `node:24-alpine` container (the build chroots into the rootfs and mounts `/proc` there) with the Gondolin version pinned in `server/package.json`, and writes the image to `images/build/<arch>/`. The host finds it there, or at `HOBWORK_IMAGE_DIR`.

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

rsync -a --exclude .git --exclude data ./ hobwork-host:hobwork-bench/
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
