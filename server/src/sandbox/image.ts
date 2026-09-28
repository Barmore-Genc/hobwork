import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../../..')

// `images/build.sh` writes the image for the host's architecture here.
export function imageDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOBWORK_IMAGE_DIR) return resolve(repoRoot, env.HOBWORK_IMAGE_DIR)
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return join(repoRoot, 'images', 'build', arch)
}

export function imageExists(dir: string): boolean {
  return existsSync(join(dir, 'manifest.json'))
}
