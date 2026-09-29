# TODO

## Slow VM boot on colossus

Create to first command takes about 2.5s on `colossus` (x86_64, KVM) versus 470ms on the Mac (HVF). See the benchmark tables in [architecture.md](architecture.md#sandboxing-gondolin). Every project cold start and pipeline run pays this.

Things to check:

- Where the time goes: kernel boot, initramfs, rootfs resize, guest init, or Gondolin's host-side setup. Compare timestamps from the guest console (`dmesg`) with host-side timing.
- Kernel command line and config for `microvm` on x86_64 (e.g. PCI/ACPI probing, `tsc` clocksource, serial console speed).
- QEMU version and flags on colossus vs the Mac, and whether `-cpu host` exposes features that slow boot.
- CPU frequency scaling and power states on colossus.

Reproduce with `pnpm -C server bench:sandbox vm` (steps in [images/README.md](../images/README.md)).

## Project UIs share the Hobwork origin

Project UIs at `/p/<project>/` run agent-written JavaScript on the same origin as the Hobwork web UI, with the signed-in user's session. That code can call Hobwork's own API as the user, including changing which hosts a secret may be sent to or assigning secrets to projects, which would let a misled agent exfiltrate a secret value. The sandbox is meant to protect against exactly this kind of agent code, so this needs fixing before project UIs hold anything sensitive.

Fix: serve project UIs from a separate origin (e.g. `<project>.apps.<host>`), with their own session cookie scoped to that origin and to the project's routes only. The Hobwork web UI and the Apple apps embed that origin in the iframe/WebView.
