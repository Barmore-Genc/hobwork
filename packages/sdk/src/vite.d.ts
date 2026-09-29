import type { ViteUserConfig } from 'vitest/config'

// Handler path without extension -> handler path, for every handler in
// `dir`/hobwork.json.
export function handlerEntries(dir: string): Record<string, string>

// The Vite and Vitest config of a Hobwork project in `dir` (default: the
// current directory): the dashboard, the handlers from hobwork.json and tests.
export function hobworkViteConfig(dir?: string): ViteUserConfig
