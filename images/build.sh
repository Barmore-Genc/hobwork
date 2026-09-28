#!/bin/sh
# Builds the Hobwork guest image for this machine's architecture into
# images/build/<arch>. Everything runs inside a Docker container so the host
# needs only Docker (the Gondolin builder wants cpio, lz4 and e2fsprogs).
set -eu

here=$(cd "$(dirname "$0")" && pwd)

case "$(uname -m)" in
  arm64 | aarch64) arch=aarch64 platform=linux/arm64 ;;
  x86_64 | amd64) arch=x86_64 platform=linux/amd64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
arch=${HOBWORK_IMAGE_ARCH:-$arch}

gondolin_version=$(sed -n 's/.*"@earendil-works\/gondolin": "\(.*\)".*/\1/p' "$here/../server/package.json")
if [ -z "$gondolin_version" ]; then
  echo 'could not read the @earendil-works/gondolin version from server/package.json' >&2
  exit 1
fi

out="build/$arch"
rm -rf "${here:?}/$out"

# --privileged: postBuild commands chroot into the rootfs and mount /proc there.
# The repo root is mounted because the image includes packages/sdk.
docker run --rm --privileged --platform "$platform" \
  -v "$here/..:/repo" -w /repo/images \
  node:24-alpine3.23 sh -euc "
    apk add --no-cache lz4 cpio e2fsprogs bash >/dev/null
    npm install --global --silent --prefix /opt/gondolin @earendil-works/gondolin@$gondolin_version
    /opt/gondolin/bin/gondolin build --arch $arch --config hobwork.json --output $out
    chown -R $(id -u):$(id -g) $out
  "

echo "Image written to $here/$out"
