// Messages between the host and the runner in a project runtime VM. The host
// reaches the runner over the VM's ingress, and the runner reaches the host at
// http://hobwork.internal. Both sides ship together with the host, so there is
// no versioning.
import type { Invocation, LogLevel } from '../index.ts'

// Inside the guest. Nothing else listens there.
export const RUNNER_PORT = 8080

export type SerializedRequest = {
  method: string
  url: string
  headers: [string, string][]
  // Base64.
  body?: string
}

export type SerializedResponse = {
  status: number
  headers: [string, string][]
  // Base64.
  body: string
}

// POST /invoke
export type InvokeRequest = {
  invocation: Invocation
  // Handler path from hobwork.json, e.g. "src/spools.ts".
  handler: string
  request?: SerializedRequest
  params?: Record<string, string>
  payload?: unknown
}

export type SerializedError = { name: string; message: string; stack?: string }

export type InvokeResult =
  | { ok: true; response: SerializedResponse }
  | { ok: false; error: SerializedError }

export type LogLine = {
  invocation?: number
  level: LogLevel
  message: string
  time: string
}

// POST http://hobwork.internal/v1/logs
export type LogBatch = { lines: LogLine[] }

// Where `pnpm build` puts a handler, relative to the build's root (the
// project's dist/). The template's vite.config.ts writes the same layout.
export function handlerModulePath(handler: string): string {
  return `handlers/${handler.replace(/^\.\//, '').replace(/\.[cm]?[jt]sx?$/, '')}.js`
}
