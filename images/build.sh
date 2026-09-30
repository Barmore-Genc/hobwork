#!/bin/sh
# Builds the Hobwork guest image for this machine's architecture into
# images/build/<arch>. Everything runs inside a Docker container so the host
# needs only Docker (the Gondolin builder wants cpio, lz4 and e2fsprogs).
set -eu

here=$(cd "$(dirname "$0")" && pwd)

# Zig builds Gondolin's guest helpers (see sandboxfs.patch); the release is pinned by checksum.
zig_version=0.16.0
arch=${HOBWORK_IMAGE_ARCH:-$(uname -m)}
case "$arch" in
  arm64 | aarch64) arch=aarch64 platform=linux/arm64 zig_sha256=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17 ;;
  x86_64 | amd64) arch=x86_64 platform=linux/amd64 zig_sha256=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

gondolin_version=$(sed -n 's/.*"@earendil-works\/gondolin": "\(.*\)".*/\1/p' "$here/../server/package.json")
if [ -z "$gondolin_version" ]; then
  echo 'could not read the @earendil-works/gondolin version from server/package.json' >&2
  exit 1
fi

out="build/$arch"
rm -rf "${here:?}/$out" "$here/build/icu-data" "$here/build/fonts" "$here/build/helpers"

# --privileged: postBuild commands chroot into the rootfs and mount /proc there.
# The repo root is mounted because the image includes packages/sdk.
docker run --rm --privileged --platform "$platform" \
  -v "$here/..:/repo" -w /repo/images \
  node:24-alpine3.23 sh -euc "
    apk add --no-cache lz4 cpio e2fsprogs bash xz patch >/dev/null
    # The Gondolin builder extracts packages without apk, so icu-data-en (a nodejs
    # dependency) would overwrite icu-data-full. Copying it in after packages keeps
    # every locale available to Intl.
    apk fetch --quiet --output /tmp icu-data-full
    mkdir -p /tmp/icu-full build/icu-data
    tar -xzf /tmp/icu-data-full-*.apk -C /tmp/icu-full usr/share/icu 2>/dev/null
    cp -R /tmp/icu-full/usr/share/icu/. build/icu-data/
    # Only the variable Inter from font-inter, for the letter of default project
    # icons; the whole package is 14MB.
    apk fetch --quiet --output /tmp font-inter
    mkdir -p /tmp/inter build/fonts
    tar -xzf /tmp/font-inter-*.apk -C /tmp/inter usr/share/fonts/inter/InterVariable.ttf 2>/dev/null
    cp /tmp/inter/usr/share/fonts/inter/InterVariable.ttf build/fonts/
    npm install --global --silent --prefix /opt/gondolin @earendil-works/gondolin@$gondolin_version
    # Gondolin mounts the workspace FUSE filesystem without allow_other, so only
    # root could use it. The patch lets the unprivileged guest user in.
    wget -q -O /tmp/zig.tar.xz https://ziglang.org/download/$zig_version/zig-$arch-linux-$zig_version.tar.xz
    echo '$zig_sha256  /tmp/zig.tar.xz' | sha256sum -c - >/dev/null
    mkdir /opt/zig
    tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1
    cp -R /opt/gondolin/lib/node_modules/@earendil-works/gondolin/dist/guest /tmp/guest
    (cd /tmp/guest && patch -p0 < /repo/images/sandboxfs.patch)
    (cd /tmp/guest && /opt/zig/zig build -Doptimize=ReleaseSmall -Dtarget=$arch-linux-musl)
    mkdir -p build/helpers
    cp /tmp/guest/zig-out/bin/* build/helpers/
    /opt/gondolin/bin/gondolin build --arch $arch --config hobwork.json --output $out
    chown -R $(id -u):$(id -g) $out build/icu-data build/fonts build/helpers
  "

echo "Image written to $here/$out"
