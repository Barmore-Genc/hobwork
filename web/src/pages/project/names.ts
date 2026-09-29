import type { InvocationKind } from '../../api.ts'

export function projectPath(name: string, path = ''): string {
  return `/projects/${encodeURIComponent(name)}${path}`
}

export const KIND_LABELS: Record<InvocationKind, string> = {
  cron: 'Schedule',
  route: 'App request',
  webhook: 'Webhook',
  trigger: 'Home Assistant',
}
