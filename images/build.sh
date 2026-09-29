#!/bin/sh
# Builds the Hobwork guest image for this machine's architecture into
# images/build/<arch>. Everything runs inside a Docker container so the host
# needs only Docker (the Gondolin builder wants cpio, lz4 and e2fsprogs).
set -eu

here=$(cd "$(dirname "$0")" && pwd)

arch=${HOBWORK_IMAGE_ARCH:-$(uname -m)}
case "$arch" in
  arm64 | aarch64) arch=aarch64 platform=linux/arm64 ;;
  x86_64 | amd64) arch=x86_64 platform=linux/amd64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

gondolin_version=$(sed -n 's/.*"@earendil-works\/gondolin": "\(.*\)".*/\1/p' "$here/../server/package.json")
if [ -z "$gondolin_version" ]; then
  echo 'could not read the @earendil-works/gondolin version from server/package.json' >&2
  exit 1
fi

out="build/$arch"
rm -rf "${here:?}/$out" "$here/build/icu-data" "$here/build/fonts"

# --privileged: postBuild commands chroot into the rootfs and mount /proc there.
# The repo root is mounted because the image includes packages/sdk.
docker run --rm --privileged --platform "$platform" \
  -v "$here/..:/repo" -w /repo/images \
  node:24-alpine3.23 sh -euc "
    apk add --no-cache lz4 cpio e2fsprogs bash >/dev/null
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
    /opt/gondolin/bin/gondolin build --arch $arch --config hobwork.json --output $out
    chown -R $(id -u):$(id -g) $out build/icu-data build/fonts
  "

echo "Image written to $here/$out"
