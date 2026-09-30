#!/bin/sh
# node_modules on the host are for its own platform, so the checkout is copied
# and installed for Linux inside the container.
set -eu
mkdir -p repo
tar -C /src \
  --exclude=./.git --exclude=./node_modules --exclude='./*/node_modules' --exclude='./packages/*/node_modules' \
  --exclude=./data --exclude=./images/build --exclude=./apple --exclude=./release/out \
  -cf - . | tar -C repo -xf -
cd repo
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --store-dir /home/node/.pnpm-store \
  --filter @hobwork/server --filter @hobwork/sdk --filter @hobwork/theme >/dev/null
# Gondolin creates its MITM CA on first use without a lock, so test files
# starting VMs in parallel in a fresh container can each write a different one.
(cd server && node --input-type=module -e "await (await import('./src/sandbox/gondolin-internals.ts')).mitmCaCertificate()")
exec "$@"
