import type { InvocationKind } from '../../api.ts'

export function projectPath(name: string, path = ''): string {
  return `/projects/${encodeURIComponent(name)}${path}`
}

export function previewPath(project: string, branch: string): string {
  return projectPath(project, `/preview/${encodeURIComponent(branch)}`)
}

export const KIND_LABELS: Record<InvocationKind, string> = {
  cron: 'Schedule',
  route: 'App request',
  webhook: 'Webhook',
  trigger: 'Home Assistant',
}

export const EVENT_LABELS: Record<string, string> = {
  start: 'Started',
  stop: 'Stopped',
  crash: 'Crashed',
  deploy: 'Update',
  'auto-revert': 'Rolled back',
  'egress-blocked': 'Blocked',
  trigger: 'Home Assistant',
  pipeline: 'Check',
  migration: 'Data change',
  db: 'Data',
  secret: 'Secret',
  project: 'Project',
}

export const PROJECT_NAME_HINT = 'Lowercase letters, digits and single hyphens, up to 40 characters.'

export function validProjectName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && name.length <= 40
}
