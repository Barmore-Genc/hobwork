#!/bin/sh
# Packages the host as release/out/hobwork-<version>-linux-<arch>.tar.gz (plus
# a .sha256) for running from a directory like /opt/hobwork/current.
#
# Needs git, node and pnpm, and must run on the target platform because
# node_modules are platform-specific (Gondolin has per-platform optional
# dependencies). Expects web/dist (`pnpm -C web build`) and images/build/<arch>
# (`images/build.sh`) built from the same commit.
set -eu

version=${1:?usage: release/package.sh <version>}
root=$(cd "$(dirname "$0")/.." && pwd)

case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

for dir in web/dist "images/build/$arch"; do
  if [ ! -d "$root/$dir" ]; then
    echo "missing $dir, build it first" >&2
    exit 1
  fi
done

name="hobwork-$version-linux-$arch"
out="$root/release/out"
stage="$out/$name"
rm -rf "$stage" "$out/$name.tar.gz" "$out/$name.tar.gz.sha256"
mkdir -p "$stage"

commit=$(git -C "$root" rev-parse HEAD)

# Committed files only, so a dirty checkout cannot leak into a release. The
# host reads everything listed here at runtime (packages/sdk is mounted into
# VMs, images/platform decides which dependencies the guest image provides).
git -C "$root" archive --format=tar HEAD \
  package.json pnpm-lock.yaml pnpm-workspace.yaml vendor/gondolin \
  server/package.json server/src server/migrations \
  packages/sdk packages/theme templates/project images/platform \
  web/package.json |
  tar -x -C "$stage"
cp -R "$root/web/dist" "$stage/web/dist"
mkdir -p "$stage/images/build"
cp -R "$root/images/build/$arch" "$stage/images/build/$arch"

# Installed in the staged tree rather than with `pnpm deploy`, because the
# server imports packages/sdk and packages/theme by relative path.
(cd "$stage" && pnpm install --frozen-lockfile --prod --filter @hobwork/server --filter @hobwork/sdk --filter @hobwork/theme --filter @earendil-works/gondolin)

# pnpm links packages with relative symlinks. An absolute one would point into
# this build machine after extraction.
absolute=$(find "$stage" -type l -exec sh -c 'for f; do case "$(readlink "$f")" in /*) echo "$f";; esac; done' _ {} +)
if [ -n "$absolute" ]; then
  echo "absolute symlinks in the package:" >&2
  echo "$absolute" >&2
  exit 1
fi

printf 'version %s\ncommit %s\n' "$version" "$commit" > "$stage/VERSION"

tar -C "$out" -czf "$out/$name.tar.gz" "$name"
(cd "$out" && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
rm -rf "$stage"

echo "$out/$name.tar.gz"
