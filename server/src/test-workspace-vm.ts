import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { repoPath, type Host } from './host.ts'
import { INTERNAL_HOST } from './sandbox/sandbox.ts'
import { TOOL_COMMAND } from './workspace-tools.ts'
import type { ExecWorkspaceVm, StartWorkspaceVm, Workspace } from './workspaces.ts'

// TEST ONLY. Stands in for a workspace VM by running commands on the host in
// the workspace directory, with the file and git tools on the PATH and pushes
// to hobwork.internal redirected to the project repo.
const MAIN = resolve(import.meta.dirname, '../../packages/sdk/src/workspace-tools/main.ts')

let binDir: string | undefined

function toolsBin(): string {
  if (!binDir) {
    binDir = mkdtempSync(join(tmpdir(), 'hobwork-tools-'))
    const script = join(binDir, TOOL_COMMAND)
    writeFileSync(script, `#!/bin/sh\nexec node --disable-warning=ExperimentalWarning ${MAIN} "$@"\n`)
    chmodSync(script, 0o755)
  }
  return binDir
}

export function hostWorkspaceVm(host: Host, workspace: Workspace): ExecWorkspaceVm {
  const repo = repoPath(host, workspace.project)
  return {
    async stop() {},
    exec(command, { cwd, signal, env, input, onOutput }) {
      return new Promise((resolvePromise, reject) => {
        const child = spawn('sh', ['-c', command], {
          cwd: join(workspace.dir, cwd),
          signal,
          env: {
            ...process.env,
            PATH: `${toolsBin()}:${process.env.PATH}`,
            HOBWORK_GIT_DIR: workspace.gitDir,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: `url.${repo}.insteadOf`,
            GIT_CONFIG_VALUE_0: `http://${INTERNAL_HOST}/git/${workspace.project}.git`,
            ...env,
          },
        })
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
        child.on('close', (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }))
        child.stdin.on('error', () => {})
        child.stdin.end(input ?? '')
      })
    },
  }
}

export function startHostWorkspaceVm(host: Host): StartWorkspaceVm<ExecWorkspaceVm> {
  return async (workspace) => hostWorkspaceVm(host, workspace)
}
