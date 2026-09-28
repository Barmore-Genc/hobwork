import { resolve } from 'node:path'

export type HomeAssistantConnection = {
  url: string
  token: string
}

export type Config = {
  dataDir: string
  port: number
  host: string
  homeAssistant?: HomeAssistantConnection
}

const repoRoot = resolve(import.meta.dirname, '../..')

function loadHomeAssistant(env: NodeJS.ProcessEnv): HomeAssistantConnection | undefined {
  const url = env.HOBWORK_HA_URL
  const token = env.HOBWORK_HA_TOKEN
  if (!url && !token) return undefined
  if (!url || !token) throw new Error('HOBWORK_HA_URL and HOBWORK_HA_TOKEN must be set together')
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new Error(`HOBWORK_HA_URL must be a URL like http://homeassistant.local:8123, got "${url}"`)
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`HOBWORK_HA_URL must start with http:// or https://, got "${url}"`)
  }
  return { url, token }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.HOBWORK_PORT ?? 7420)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`HOBWORK_PORT must be an integer from 0 to 65535, got "${env.HOBWORK_PORT}"`)
  }
  return {
    dataDir: resolve(repoRoot, env.HOBWORK_DATA_DIR ?? 'data'),
    port,
    host: env.HOBWORK_HOST ?? '127.0.0.1',
    homeAssistant: loadHomeAssistant(env),
  }
}
