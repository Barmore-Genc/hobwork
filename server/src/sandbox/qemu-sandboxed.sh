#!/bin/sh
# Gondolin builds the whole QEMU command line and only lets us pick the binary,
# so this stands in for it to add the seccomp filter (same options as libvirt).
exec "qemu-system-$(uname -m)" \
  -sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny \
  "$@"
