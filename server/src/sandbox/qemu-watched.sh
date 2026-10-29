#!/bin/sh
# Gondolin kills QEMU only when the host exits normally. A host killed by a
# signal or crashing would leave QEMU running, so a watcher kills it once the
# host is gone. exec keeps this PID for QEMU, so the host's own signals reach it.
host=$PPID
vm=$$
(
  while kill -0 "$host" 2>/dev/null && kill -0 "$vm" 2>/dev/null; do sleep 1; done
  kill -0 "$host" 2>/dev/null || kill -KILL "$vm" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
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
if [ "${HOBWORK_QEMU_SANDBOX:-}" = 1 ]; then exec "$(dirname "$0")/qemu-sandboxed.sh" "$@"; fi
machine=$(uname -m)
[ "$machine" = arm64 ] && machine=aarch64
exec "qemu-system-$machine" "$@"
