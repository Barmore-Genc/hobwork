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
}
