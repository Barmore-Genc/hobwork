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
if [ "${HOBWORK_QEMU_SANDBOX:-}" = 1 ]; then exec "$(dirname "$0")/qemu-sandboxed.sh" "$@"; fi
machine=$(uname -m)
[ "$machine" = arm64 ] && machine=aarch64
exec "qemu-system-$machine" "$@"
