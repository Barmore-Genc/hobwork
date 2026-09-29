// Entry point of the runner in a project runtime VM: node main.ts
import { readFileSync, unlinkSync } from 'node:fs'
import { RUNNER_PORT, RUNNER_TOKEN_FILE } from './protocol.ts'
import { startRunner } from './runner.ts'

// A handler's stray promise or timer must not take down the other invocations.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection outside an invocation:', reason))
process.on('uncaughtException', (err) => console.error('Uncaught exception outside an invocation:', err))

try {
  // Read from a file that is deleted at once, unlike an env var, which handler
  // code could still read from /proc/self/environ.
  const tokenFile = process.env.HOBWORK_RUNNER_TOKEN_FILE ?? RUNNER_TOKEN_FILE
  const token = readFileSync(tokenFile, 'utf8').trim()
  unlinkSync(tokenFile)
  if (!token) throw new Error('The runner token is empty')
  await startRunner(
    {
      token,
      appDir: process.env.HOBWORK_APP_DIR ?? '/app',
      internalUrl: process.env.HOBWORK_INTERNAL_URL ?? 'http://hobwork.internal',
      handlers: JSON.parse(process.env.HOBWORK_HANDLERS ?? '[]') as string[],
      // The sandbox puts each secret's placeholder in an env var of the same name.
      secrets: Object.fromEntries(
        (JSON.parse(process.env.HOBWORK_SECRETS ?? '[]') as string[]).map((name) => [name, process.env[name] ?? '']),
      ),
    },
    Number(process.env.HOBWORK_RUNNER_PORT ?? RUNNER_PORT),
  )
  console.log('Runner ready')
} catch (err) {
  console.error('Runner could not start:', err)
  process.exit(1)
}
