export type Logger = {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export type Context = {
  fetch: typeof fetch
  log: Logger
}

export type Handler<Input = unknown, Output = unknown> = (
  ctx: Context,
  input: Input,
) => Output | Promise<Output>
