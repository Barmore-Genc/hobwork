import { resolve } from 'node:path'

export type Config = {
  dataDir: string
  port: number
  host: string
}

const repoRoot = resolve(import.meta.dirname, '../..')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.HOBWORK_PORT ?? 7420)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`HOBWORK_PORT must be an integer from 0 to 65535, got "${env.HOBWORK_PORT}"`)
  }
  return {
    dataDir: resolve(repoRoot, env.HOBWORK_DATA_DIR ?? 'data'),
    port,
    host: env.HOBWORK_HOST ?? '127.0.0.1',
  }
}
