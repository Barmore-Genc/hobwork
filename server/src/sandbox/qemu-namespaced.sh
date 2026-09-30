#!/bin/sh
# Starts QEMU in its own namespaces with the bwrap options the host wrote to
# qemu.bwrap in the VM's directory (see isolation.ts). Gondolin builds the
# whole QEMU command line and only lets the host pick the binary, so this
# stands in for it.
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
# Gondolin checks that the binary runs before it starts a VM.
if [ "$*" = --version ]; then exec "qemu-system-$(uname -m)" --version; fi
sockets=
for arg; do
  case $arg in
    socket,id=virtiocon0,path=*) sockets=${arg#socket,id=virtiocon0,path=}; sockets=${sockets%/*} ;;
  esac
done
if [ -z "$sockets" ]; then
  echo 'qemu-namespaced.sh: no control socket in the QEMU arguments' >&2
  exit 1
fi
dir=${sockets%/*}
# Gondolin's own fs bridge listens where QEMU cannot reach it. The VFS worker
# serves the VM's mounts on this socket instead.
for arg; do
  shift
  case $arg in
    socket,id=virtiofs0,path=*) arg="socket,id=virtiofs0,path=$dir/fs/fs.sock,server=off" ;;
  esac
  set -- "$@" "$arg"
done
if [ "${HOBWORK_QEMU_SANDBOX:-}" = 1 ]; then qemu=$here/qemu-sandboxed.sh; else qemu=qemu-system-$(uname -m); fi
exec bwrap --args 3 -- "$qemu" "$@" 3<"$dir/qemu.bwrap"
