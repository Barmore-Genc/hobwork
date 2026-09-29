import type { Access } from './api.ts'

export const FULL_ACCESS: Access = { readOnly: false, projects: null }

export function accessReady(access: Access): boolean {
  return access.projects === null || access.projects.length > 0
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? 'no hobs'
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

export function projectsText(access: Access): string {
  return access.projects === null ? 'all hobs' : list(access.projects)
}

export function accessText(access: Access): string {
  return `${access.readOnly ? 'Can read' : 'Can change'} ${projectsText(access)}`
}
