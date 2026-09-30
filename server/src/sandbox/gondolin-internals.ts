import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { VirtualProvider } from '@earendil-works/gondolin'

// Gondolin does not export its mount router, frame codec or MITM CA loader
// (`exports` allows only the package root), and the VFS worker needs them to
// serve the fs socket outside Gondolin's own server. They are imported by
// file path, which only holds for the vendored version. The Gondolin changes
// that would replace this are in docs/todo.md (Sandbox account).
const PINNED = '0.12.0'

const packageJson = createRequire(import.meta.url).resolve('@earendil-works/gondolin/package.json')
const entry = new URL('dist/src/', pathToFileURL(packageJson))
const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }
if (version !== PINNED) {
  throw new Error(`server/src/sandbox/gondolin-internals.ts imports Gondolin ${PINNED} internals, but ${version} is installed. Check the imported modules and update PINNED.`)
}

function load<T>(path: string): Promise<T> {
  return import(new URL(path, entry).href) as Promise<T>
}

export type FsRequestMessage = { v: number, t: 'fs_request', id: number, p: { op: string } }
export type FsResponseMessage = { v: 1, t: 'fs_response', id: number, p: { op: string, err: number, message?: string } }

type MountsModule = {
  MountRouterProvider: new (mounts: Map<string, VirtualProvider>) => VirtualProvider
  normalizeMountMap(mounts: Record<string, VirtualProvider>): Map<string, VirtualProvider>
}
type ProtocolModule = {
  FrameReader: new () => { push(chunk: Buffer, onFrame: (frame: Buffer) => void): void }
  decodeMessage(frame: Buffer): { t: string, id?: unknown, p?: unknown }
  encodeFrame(message: object): Buffer
}
type ErrnoModule = { LINUX_ERRNO: { EIO: number } }
type MitmModule = {
  resolveMitmCertDir(dir?: string): string
  loadOrCreateMitmCaSync(dir: string): { certPem: string }
}

const mounts = await load<MountsModule>('./vfs/mounts.js')
const protocol = await load<ProtocolModule>('./sandbox/virtio-protocol.js')
const errno = await load<ErrnoModule>('./vfs/linux-errno.js')

export const MountRouterProvider = mounts.MountRouterProvider
export const normalizeMountMap = mounts.normalizeMountMap
export const FrameReader = protocol.FrameReader
export const decodeMessage = protocol.decodeMessage
export const encodeFrame = protocol.encodeFrame
export const EIO = errno.LINUX_ERRNO.EIO

// The certificate Gondolin mounts at /etc/gondolin/mitm/ca.crt, from the CA
// the host's network stack signs with (Gondolin's default directory, since
// Hobwork sets none). The worker gets only the certificate, never the key.
export async function mitmCaCertificate(): Promise<string> {
  const mitm = await load<MitmModule>('./mitm.js')
  const pem = mitm.loadOrCreateMitmCaSync(mitm.resolveMitmCertDir()).certPem
  return pem.endsWith('\n') ? pem : `${pem}\n`
}
