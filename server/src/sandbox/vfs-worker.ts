// Serves one VM's mounts on its fs socket, in its own namespaces (see
// isolation.ts), so a guest that escapes a mount through the VFS finds only
// what this process can see. Reads its config as one JSON line on stdin,
// prints `ready` once it listens, and exits when the host closes stdin or
// QEMU closes the socket.
import { createServer, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { FsRpcService, MemoryProvider, SandboxVfsProvider, serializeListenersFile } from '@earendil-works/gondolin'
import type { VirtualProvider } from '@earendil-works/gondolin'
import {
  decodeMessage,
  EIO,
  encodeFrame,
  FrameReader,
  MountRouterProvider,
  normalizeMountMap,
  type FsRequestMessage,
  type FsResponseMessage,
} from './gondolin-internals.ts'
import { toProviders } from './mounts.ts'
import type { Mount } from './sandbox.ts'

export type VfsWorkerConfig = {
  socketPath: string
  mounts: Record<string, Mount>
  mitmCaCertificate: string
}

function readOnlyFiles(files: Record<string, string>): VirtualProvider {
  const provider = new MemoryProvider()
  for (const [path, content] of Object.entries(files)) {
    const handle = provider.openSync(path, 'w')
    handle.writeFileSync(content)
    handle.closeSync()
  }
  provider.setReadOnly()
  return provider
}

// The in-process VFS also has /etc/gondolin (ingress listeners) and the MITM
// CA certificate. The host keeps ingress routes itself, so the guest gets an
// empty, read-only listeners file.
function vfsProvider(config: VfsWorkerConfig): VirtualProvider {
  return new SandboxVfsProvider(new MountRouterProvider(normalizeMountMap({
    ...toProviders(config.mounts),
    '/etc/gondolin': readOnlyFiles({ '/listeners': serializeListenersFile({ routes: [] }) }),
    '/etc/gondolin/mitm': readOnlyFiles({ '/ca.crt': config.mitmCaCertificate }),
  })))
}

function serve(socket: Socket, service: FsRpcService) {
  const reader = new FrameReader()
  const handle = async (message: FsRequestMessage) => {
    let response: FsResponseMessage
    try {
      response = await service.handleRequest(message as never) as FsResponseMessage
    } catch (err) {
      response = { v: 1, t: 'fs_response', id: message.id, p: { op: message.p.op, err: EIO, message: err instanceof Error ? err.message : 'fs handler error' } }
    }
    if (!socket.destroyed) socket.write(encodeFrame(response))
  }
  socket.on('data', (chunk: Buffer) => {
    try {
      reader.push(chunk, (frame) => {
        const message = decodeMessage(frame)
        if (message.t !== 'fs_request' || !Number.isInteger(message.id) || (message.id as number) < 0) return
        void handle(message as FsRequestMessage)
      })
    } catch (err) {
      console.error(`vfs worker: bad frame from QEMU: ${err instanceof Error ? err.message : String(err)}`)
      socket.destroy()
    }
  })
  socket.on('error', (err) => console.error(`vfs worker: ${err.message}`))
  socket.on('close', () => process.exit(0))
}

const input = createInterface({ input: process.stdin })
input.on('close', () => process.exit(0))
const config = await new Promise<VfsWorkerConfig>((resolve) => input.once('line', (line) => resolve(JSON.parse(line))))

const service = new FsRpcService(vfsProvider(config))
const server = createServer((socket) => {
  // QEMU connects once. Nobody else gets a second connection.
  server.close()
  serve(socket, service)
})
server.on('error', (err) => {
  console.error(`vfs worker: ${err.message}`)
  process.exit(1)
})
server.listen(config.socketPath, () => process.stdout.write('ready\n'))
