#!/bin/sh
# Builds the Hobwork guest image for this machine's architecture into
# images/build/<arch>. Everything runs inside a Docker container so the host
# needs only Docker (the Gondolin builder wants cpio, lz4 and e2fsprogs).
set -eu

here=$(cd "$(dirname "$0")" && pwd)

# Zig builds the guest helpers from vendor/gondolin; the release is pinned by checksum.
zig_version=0.16.0
arch=${HOBWORK_IMAGE_ARCH:-$(uname -m)}
case "$arch" in
  arm64 | aarch64) arch=aarch64 platform=linux/arm64 zig_sha256=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17 ;;
  x86_64 | amd64) arch=x86_64 platform=linux/amd64 zig_sha256=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

out="build/$arch"
rm -rf "${here:?}/$out" "$here/build/icu-data" "$here/build/fonts" "$here/build/helpers"

# --privileged: postBuild commands chroot into the rootfs and mount /proc there.
# The repo root is mounted because the image includes packages/sdk and the
# builder comes from vendor/gondolin.
docker run --rm --privileged --platform "$platform" \
  -v "$here/..:/repo" -w /repo/images \
  node:24-alpine3.23 sh -euc "
    apk add --no-cache lz4 cpio e2fsprogs bash xz >/dev/null
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
    # A copy, so the builder's dependencies install for the container's platform.
    cp -R /repo/vendor/gondolin /opt/gondolin
    rm -rf /opt/gondolin/node_modules
    (cd /opt/gondolin && npm install --silent --omit=optional --ignore-scripts)
    wget -q -O /tmp/zig.tar.xz https://ziglang.org/download/$zig_version/zig-$arch-linux-$zig_version.tar.xz
    echo '$zig_sha256  /tmp/zig.tar.xz' | sha256sum -c - >/dev/null
    mkdir /opt/zig
    tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1
    cp -R /opt/gondolin/dist/guest /tmp/guest
    (cd /tmp/guest && /opt/zig/zig build -Doptimize=ReleaseSmall -Dtarget=$arch-linux-musl)
    mkdir -p build/helpers
    cp /tmp/guest/zig-out/bin/* build/helpers/
    node /opt/gondolin/dist/bin/gondolin.js build --arch $arch --config hobwork.json --output $out
    chown -R $(id -u):$(id -g) $out build/icu-data build/fonts build/helpers
  "

echo "Image written to $here/$out"
