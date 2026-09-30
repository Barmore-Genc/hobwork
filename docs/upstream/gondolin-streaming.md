# Gondolin: streamed request bodies and hook responses

An upstream change for [Gondolin](https://github.com/earendil-works/gondolin), written against its `main` (29fa74d, after v0.12.0; `host/src/qemu/http.ts` has not changed since v0.12.0). The diff is `gondolin-streaming.diff` next to this file and applies with `git apply` at the Gondolin repo root. Hobwork carries the same change, built from v0.12.0, as `patches/@earendil-works__gondolin@0.12.0.patch` (the compiled `dist` files).

## Problem

Gondolin mediates guest HTTP in the host process (`host/src/qemu/http.ts`). For request bodies it has two paths:

- `Content-Length` bodies that have not fully arrived with the head are streamed into `onRequest` and the upstream `fetch` through a `ReadableStream`, with backpressure (the QEMU socket pauses above 512KB pending). But the head check rejects any `Content-Length` above `maxHttpBodyBytes` (default 64MB, `DEFAULT_MAX_HTTP_BODY_BYTES` in `qemu/net.ts`) with 413 before streaming starts.
- `Transfer-Encoding: chunked` bodies are always buffered in full (`decodeChunkedBodyFromReceiveBuffer`) and capped at `maxHttpBodyBytes`.

`git push` over smart HTTP sends packs larger than `http.postBuffer` (1MB) chunked, so a push over 64MB from a guest to a host-side git handler fails. Raising `maxHttpBodyBytes` for the whole VM would let a guest make the host buffer that much for every host.

Responses have a similar limit: a `Response` returned by `onRequest` is read in full (`webResponseToInternalHttpResponse` with `maxHttpResponseBodyBytes`) before anything reaches the guest, so a synthetic or proxied response cannot stream (server-sent events arrive in one piece) and is capped at 64MB. Upstream responses already stream when there is no `onResponse` hook.

## API

```ts
type HttpHooks = {
  // ...
  /**
   * per-request opt-in to stream the request body (request body is always `null`)
   *
   * When this returns `true`, the body reaches `onRequest` and the upstream
   * fetch as a stream with backpressure to the guest, including chunked
   * bodies, and `maxHttpBodyBytes` does not apply to it.
   */
  streamRequestBody?: (request: Request) => Promise<boolean> | boolean;
};
```

`createHttpHooks` passes `streamRequestBody` through. It is called once per request that has a body, with the parsed head (method, URL, headers after hop-by-hop stripping), before policy checks. Without the hook, or when it returns anything but `true`, nothing changes.

With `true`:

- The `maxHttpBodyBytes` check on `Content-Length` is skipped.
- A `Content-Length` body is always streamed, even when it arrived with the head.
- A chunked body is decoded incrementally (`ChunkedBodyDecoder`, one framing line in memory at most, chunk-size lines up to 1KB, trailers up to `MAX_HTTP_HEADER_BYTES`) and pushed into the same stream state as `Content-Length` bodies, so backpressure, cancellation and pipelined-byte handling are shared. The request that reaches `onRequest` and `fetch` has neither `Transfer-Encoding` nor `Content-Length`; `fetch` sends it chunked. `Expect: 100-continue` is answered before streaming starts.
- Malformed chunked framing after streaming started errors the body stream and aborts the TCP flow (`http-invalid-chunked-body`), since a response may already be in flight.
- If `onRequest` replaces the body, it is materialized with `maxHttpBodyBytes` as before.

Responses returned by `onRequest` are no longer buffered. `sendHookResponse` streams them like upstream responses: with their `Content-Length` when they declare one (a body of another length fails the request), else chunked to HTTP/1.1 clients and close-delimited to HTTP/1.0 clients. HEAD, 204, 205 and 304 keep the old header normalization. `maxHttpResponseBodyBytes` no longer applies to them; it still applies when `onResponse` needs a buffered upstream response. This is a wire change for callers: a hook `Response` without `Content-Length` used to go out with one and now goes out chunked. Four tests in `qemu-net.test.ts` compared raw bytes and now decode chunked bodies. If maintainers prefer, it could be gated behind an option, but it matches how upstream responses already stream.

## Diff overview

- `host/src/qemu/contracts.ts`: `HttpHooks.streamRequestBody`.
- `host/src/http/hooks.ts`: `CreateHttpHooksOptions.streamRequestBody`, passed through.
- `host/src/internal/http-conversion.ts`: `webResponseHeadToInternalHttpResponse` split out of `webResponseToInternalHttpResponse` (status, status text, headers with `Set-Cookie` kept as a list).
- `host/src/qemu/http.ts`:
  - `ChunkedBodyDecoder` (exported for tests).
  - `HttpSession.head.streamBody` and `HttpSession.streamingBody.chunked`; `isStreamingBodyComplete` replaces `remaining === 0` checks.
  - `handleHttpDataWithWriter`: asks `streamRequestBody` after parsing the head (with the same re-entrancy guard as the policy precheck), skips the 413 when it opted in, routes chunked bodies and opted-in `Content-Length` bodies to `startStreamingRequestBody`.
  - `startStreamingRequestBody`: the former inline `Content-Length` streaming block, moved into a function and extended for chunked bodies. Most of the diff's size is this move.
  - `normalizeRequestHookOutcome` returns the hook's `Response` as it is; `applyRequestHooks` returns it as `shortCircuitResponse`; `fetchHookRequestAndRespond` and `handleWebSocketUpgrade` send it with `sendHookResponse`.
- `host/test/http-streaming-bodies.test.ts`: decoder (byte-by-byte input, malformed framing), `Content-Length` and chunked bodies over `maxHttpBodyBytes` into `onRequest` and upstream, the limit when the hook declines, no call for bodiless requests, abort on bad framing, a hook response that streams before its body ends, declared `Content-Length`, HTTP/1.0.
- `docs/sdk-network.md`, `docs/network.md`, `CHANGELOG.md`.

`pnpm -C host test` passes except `deleteFile rejects recursive missing paths without force`, which fails on macOS without the change too.

## Hobwork use

`server/src/sandbox/gondolin.ts` opts in only for `hobwork.internal` requests that `SandboxOptions.streamInternal` accepts; workspace VMs accept pushes to `/git/<hob>.git` (`streamsWorkspaceGitBody` in `server/src/workspace-git.ts`), which pipe into `git http-backend` with git's own `receive.maxInputSize` as the limit.
