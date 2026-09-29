# TODO

## Slow VM boot on colossus

Create to first command takes about 2.5s on `colossus` (x86_64, KVM) versus 470ms on the Mac (HVF). See the benchmark tables in [architecture.md](architecture.md#sandboxing-gondolin). Every project cold start and pipeline run pays this.

Things to check:

- Where the time goes: kernel boot, initramfs, rootfs resize, guest init, or Gondolin's host-side setup. Compare timestamps from the guest console (`dmesg`) with host-side timing.
- Kernel command line and config for `microvm` on x86_64 (e.g. PCI/ACPI probing, `tsc` clocksource, serial console speed).
- QEMU version and flags on colossus vs the Mac, and whether `-cpu host` exposes features that slow boot.
- CPU frequency scaling and power states on colossus.

Reproduce with `pnpm -C server bench:sandbox vm` (steps in [images/README.md](../images/README.md)).
