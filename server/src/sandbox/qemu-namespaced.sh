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
# Guest RAM is marked mergeable, so a host running KSM merges the pages every VM
# holds the same copy of: the kernel, the initramfs, and what each guest read
# from the same rootfs. QEMU refuses the option on a kernel without KSM, so by
# default it is only asked for where the kernel has it. HOBWORK_VM_MEMORY_MERGE
# turns this off (0) or asks for it anyway (1).
merge=
case ${HOBWORK_VM_MEMORY_MERGE:-} in
  0) ;;
  1) merge=1 ;;
  *) if [ -d /sys/kernel/mm/ksm ]; then merge=1; fi ;;
esac
if [ -n "$merge" ]; then
  # QEMU takes -machine once, and Gondolin writes it as `-machine <machine>
  # [,<option>]...`, so the option has to go into that value.
  next=
  for arg; do
    shift
    if [ -n "$next" ]; then
      case ,$arg, in
        *,mem-merge=*) ;;
        *) arg=$arg,mem-merge=on ;;
      esac
      next=
    elif [ "$arg" = -machine ] || [ "$arg" = -M ]; then
      next=1
    fi
    set -- "$@" "$arg"
  done
fi
if [ "${HOBWORK_QEMU_SANDBOX:-}" = 1 ]; then qemu=$here/qemu-sandboxed.sh; else qemu=qemu-system-$(uname -m); fi
# The host stops VMs itself when it runs out of memory, and the kernel's own OOM
# killer is the backstop for when that comes too late. Its score is mostly how
# much memory a process holds, which a QEMU usually wins, so marking QEMU puts
# it ahead of the host's own processes instead of leaving the two to compete.
if [ -w /proc/self/oom_score_adj ]; then echo 1000 > /proc/self/oom_score_adj 2>/dev/null || true; fi
exec bwrap --args 3 -- "$qemu" "$@" 3<"$dir/qemu.bwrap"
