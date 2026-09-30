import type { ReadableStream as WebReadableStream } from "stream/web";
import type { QemuNetworkBackend, TcpSession } from "./contracts.js";
import type { InternalHttpRequest } from "../internal/http-types.js";
import { HttpReceiveBuffer, MAX_HTTP_HEADER_BYTES } from "../http/utils.js";
export { MAX_HTTP_HEADER_BYTES };
export declare const MAX_HTTP_PIPELINE_BYTES: number;
/**
 * Incremental `Transfer-Encoding: chunked` decoder for streamed request bodies.
 * Unlike `decodeChunkedBodyFromReceiveBuffer` it never holds more than one
 * framing line in memory.
 */
export declare class ChunkedBodyDecoder {
    private state;
    private line;
    private chunkRemaining;
    private trailerBytes;
    /** whether the last-chunk and trailer section were consumed */
    done: boolean;
    /** decodes `data`, returning body bytes and bytes after the body end */
    push(data: Buffer): {
        body: Buffer[];
        extra: Buffer;
    };
}
export type HttpSession = {
    buffer: HttpReceiveBuffer;
    processing: boolean;
    closed: boolean;
    /** whether the current upstream dispatcher is tainted */
    upstreamTainted: boolean;
    /** origin key for the current upstream dispatcher */
    upstreamOriginKey: string | null;
    /** cached request head state (we only process one HTTP request per TCP session) */
    head?: {
        method: string;
        target: string;
        version: string;
        headers: Record<string, string>;
        bodyOffset: number;
        requestBase: InternalHttpRequest;
        maxBodyBytes: number;
        /** whether request/ip policy already ran on parsed head */
        policyPrechecked: boolean;
        bodyMode: "none" | "content-length" | "chunked";
        contentLength: number;
        /** whether `httpHooks.streamRequestBody` opted this request into streaming */
        streamBody: boolean;
    };
    /** active streaming request body state */
    streamingBody?: {
        /** bytes remaining in the declared Content-Length body in `bytes` (chunked: unused) */
        remaining: number;
        /** incremental decoder for chunked bodies (`null` for Content-Length) */
        chunked: ChunkedBodyDecoder | null;
        /** upstream body stream controller */
        controller: ReadableStreamDefaultController<Uint8Array> | null;
        /** whether the body stream is complete or canceled */
        done: boolean;
        /** whether to discard remaining declared body bytes instead of enqueueing */
        dropRemainingBody: boolean;
        /** bytes observed after body completion in `bytes` (HTTP pipelining/coalescing) */
        pipelineBytes: number;
        /** pending body chunks not yet enqueued into the ReadableStream */
        pending: Buffer[];
        /** pending body bytes not yet enqueued into the ReadableStream in `bytes` */
        pendingBytes: number;
        /** close the stream after pending bytes are drained */
        closeAfterPending: boolean;
        /** drains pending chunks into the ReadableStream while respecting backpressure */
        drain: () => void;
    };
    /** whether we already sent an interim 100-continue response */
    sentContinue?: boolean;
};
export declare function updateQemuRxPauseState(backend: QemuNetworkBackend): void;
export declare function handlePlainHttpData(backend: QemuNetworkBackend, key: string, session: TcpSession, data: Buffer): Promise<void>;
export declare function handleTlsHttpData(backend: QemuNetworkBackend, key: string, session: TcpSession, data: Buffer): Promise<void>;
export declare function handleHttpDataWithWriter(backend: QemuNetworkBackend, key: string, session: TcpSession, data: Buffer, options: {
    scheme: "http" | "https";
    write: (chunk: Buffer) => void;
    finish: () => void;
    waitForWritable?: () => Promise<void>;
}): Promise<void>;
export declare function fetchHookRequestAndRespond(backend: QemuNetworkBackend, options: {
    request: InternalHttpRequest;
    httpVersion: "HTTP/1.0" | "HTTP/1.1";
    write: (chunk: Buffer) => void;
    waitForWritable?: () => Promise<void>;
    /** whether first-hop request/ip policies already ran on parsed head */
    policyCheckedFirstHop?: boolean;
    /** optional streaming request body for the initial hop */
    initialBodyStream?: WebReadableStream<Uint8Array> | null;
    /** whether the initial body stream carries a request body */
    initialBodyStreamHasBody?: boolean;
    /** session state for dispatcher taint tracking */
    httpSession: HttpSession;
}): Promise<void>;
export declare function resolveHostname(backend: QemuNetworkBackend, hostname: string, policy?: {
    protocol: "http" | "https";
    port: number;
}): Promise<{
    address: string;
    family: 4 | 6;
}>;
//# sourceMappingURL=http.d.ts.map