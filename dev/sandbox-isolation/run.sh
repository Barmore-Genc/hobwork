#!/bin/sh
# Runs a command against this checkout in a Linux container with bubblewrap
# and QEMU, as an unprivileged user, with HOBWORK_SANDBOX_ISOLATION=namespaces
# unless set otherwise. See README.md.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
case "$(uname -m)" in
  arm64 | aarch64) arch=aarch64 ;;
  *) arch=x86_64 ;;
esac
image=${HOBWORK_IMAGE_DIR:-$root/images/build/$arch}
if [ ! -f "$image/manifest.json" ]; then
  echo "no guest image at $image, run images/build.sh or set HOBWORK_IMAGE_DIR" >&2
  exit 1
fi
if [ ! -c /dev/kvm ]; then
  echo "no /dev/kvm: VMs under QEMU emulation (TCG) take hours, run this on a Linux host with KVM" >&2
  exit 1
fi
docker build -q -t hobwork-sandbox-isolation "$here" >/dev/null
tty=-i
if [ -t 0 ]; then tty=-it; fi
# --privileged lets the unprivileged user in the container create user
# namespaces and mount /proc in them, which Docker's default seccomp profile
# and masked /proc paths prevent.
exec docker run --rm $tty --privileged --device /dev/kvm \
  -v "$root:/src:ro" \
  -v "$image:/image:ro" \
  -v hobwork-sandbox-isolation-pnpm:/home/node/.pnpm-store \
  -e HOBWORK_IMAGE_DIR=/image \
  -e HOBWORK_SANDBOX_ISOLATION="${HOBWORK_SANDBOX_ISOLATION:-namespaces}" \
  -e HOBWORK_QEMU_SANDBOX="${HOBWORK_QEMU_SANDBOX:-}" \
  -e HOBWORK_VM_TESTS="${HOBWORK_VM_TESTS:-}" \
  hobwork-sandbox-isolation "$@"
