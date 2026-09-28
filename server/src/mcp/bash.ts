import type { ExecWorkspaceVm } from '../workspaces.ts'
import { truncateMiddle } from './output.ts'

export type BashOutcome = { text: string; failed: boolean }

function section(name: string, text: string): string {
  return text ? `\n--- ${name} ---\n${truncateMiddle(text)}` : ''
}

// Resolves on timeout or cancellation even if the backend never settles, with
// whatever output was streamed so far.
export async function runBash(
  vm: ExecWorkspaceVm,
  command: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<BashOutcome> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  const streamed = { stdout: '', stderr: '' }

  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted')
    signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  const result = await Promise.race([
    vm.exec(command, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal,
      onOutput: (stream, chunk) => {
        streamed[stream] += chunk
      },
    }),
    aborted,
  ])

  if (result === 'aborted' || timeout.aborted) {
    const reason = timeout.aborted
      ? `Command timed out after ${options.timeoutMs / 1000}s and was stopped. Pass a larger timeout_seconds for slow commands.`
      : 'Command was cancelled.'
    const output = result === 'aborted' ? streamed : result
    return { text: reason + section('stdout', output.stdout) + section('stderr', output.stderr), failed: true }
  }
  return {
    text: `exit code: ${result.exitCode}` + section('stdout', result.stdout) + section('stderr', result.stderr),
    failed: false,
  }
}
