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

Needs Docker, `qemu-system-x86_64`, `qemu-img`, Node >= 24.12 and read-write access to `/dev/kvm`.

```sh
npx pnpm@12.5.1 install
images/build.sh                        # writes images/build/x86_64
npx pnpm@12.5.1 -C server test:vm
npx pnpm@12.5.1 -C server bench:sandbox
```
