// The tools the host runs in workspace VMs: file operations and git on the
// checkout. The host mounts this directory into every workspace VM. Usage:
// `main.ts files|git`, the request as JSON on stdin, one JSON line on stdout.
// The host treats the answer as untrusted and checks it.
import { runFileRequest, type FileRequest } from './files.ts'
import { ToolError } from './error.ts'
import { runGitRequest, type GitRequest } from './git.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<unknown> {
  const tool = process.argv[2]
  const request: unknown = JSON.parse(await readStdin())
  if (tool === 'files') return runFileRequest(process.cwd(), request as FileRequest)
  if (tool === 'git') return runGitRequest(process.cwd(), request as GitRequest)
  throw new Error(`Unknown tool "${tool}"`)
}

try {
  process.stdout.write(`${JSON.stringify({ ok: true, result: await main() })}\n`)
} catch (err) {
  const user = err instanceof ToolError
  const message = err instanceof Error ? err.message : String(err)
  process.stdout.write(`${JSON.stringify({ ok: false, user, error: message })}\n`)
}
