import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type PackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const platformPackageJson = resolve(import.meta.dirname, '../../images/platform/package.json')

// Not in the platform package.json because they are not on npm. The image
// build copies them from packages/sdk and packages/theme.
const HOBWORK_PACKAGES = ['@hobwork/sdk', '@hobwork/theme']

function dependencyNames(pkg: PackageJson): string[] {
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
}

// The packages the guest image provides at /node_modules.
export function platformPackages(): Set<string> {
  const pkg = JSON.parse(readFileSync(platformPackageJson, 'utf8')) as PackageJson
  return new Set([...dependencyNames(pkg), ...HOBWORK_PACKAGES])
}

export function extraDependencies(pkg: PackageJson, platform: Set<string> = platformPackages()): string[] {
  return dependencyNames(pkg).filter((name) => !platform.has(name))
}
