import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { templateDir } from '../projects.ts'

type PackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function dependencyNames(pkg: PackageJson): string[] {
  return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
}

// The template's package.json is the single definition of the platform
// dependency set: new projects start with exactly these packages, and the guest
// image provides them.
export function platformPackages(): Set<string> {
  const pkg = JSON.parse(readFileSync(join(templateDir, 'package.json'), 'utf8')) as PackageJson
  return new Set(dependencyNames(pkg))
}

export function extraDependencies(pkg: PackageJson, platform: Set<string> = platformPackages()): string[] {
  return dependencyNames(pkg).filter((name) => !platform.has(name))
}
