import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { StartPipelineVm } from './runner.ts'

// DEV AND TEST ONLY. Runs pipeline commands directly on the host with `sh -c`,
// with no sandbox at all. The host must never execute project code in
// production, so this is never wired up by default; use a Gondolin backend.
export const startHostPipelineVm: StartPipelineVm = async ({ dir }) => ({
  async stop() {},
  exec(command, { cwd, signal, onOutput }) {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', command], { cwd: join(dir, cwd), signal })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk
        onOutput?.('stdout', chunk.toString())
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk
        onOutput?.('stderr', chunk.toString())
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
    })
  },
})
