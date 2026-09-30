# Hobwork changes to Gondolin

This is `@earendil-works/gondolin` 0.12.0 as published on npm (Apache-2.0, see `LICENSE`), with the changes below. The first commit that adds this directory is the unchanged package, so `git diff <that commit> -- vendor/gondolin` shows every change.

- `package.json`: private, without the build and publish scripts and dev dependencies.
- Streaming request bodies: `httpHooks.streamRequestBody` (`dist/src/http/hooks.*`, `dist/src/internal/http-conversion.*`, `dist/src/qemu/contracts.d.ts`, `dist/src/qemu/http.*`). A request the hook opts in reaches `onRequest` with its body as a stream, with backpressure to the guest and no size limit.
- Streaming answers: a `Response` from `onRequest` is streamed to the guest instead of buffered (`dist/src/qemu/http.js`).
- `VM.exited` (`dist/src/vm/core.*`): resolves when the VM process ends.
- `sandboxfs` (`dist/guest/src/sandboxfs/main.zig`): mounts with FUSE's `allow_other` and reports uid and gid 1000 (Hobwork's guest user) for every file.
