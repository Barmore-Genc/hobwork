// Entry point of the runner in a project runtime VM: node main.ts
import { RUNNER_PORT } from './protocol.ts'
import { startRunner } from './runner.ts'

// A handler's stray promise or timer must not take down the other invocations.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection outside an invocation:', reason))
process.on('uncaughtException', (err) => console.error('Uncaught exception outside an invocation:', err))

try {
  await startRunner(
    {
      appDir: process.env.HOBWORK_APP_DIR ?? '/app',
      internalUrl: process.env.HOBWORK_INTERNAL_URL ?? 'http://hobwork.internal',
      handlers: JSON.parse(process.env.HOBWORK_HANDLERS ?? '[]') as string[],
    },
    Number(process.env.HOBWORK_RUNNER_PORT ?? RUNNER_PORT),
  )
  console.log('Runner ready')
} catch (err) {
  console.error('Runner could not start:', err)
  process.exit(1)
}
