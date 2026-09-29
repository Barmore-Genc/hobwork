import type { InvocationStatus } from '../../api.ts'

const STATUS: Record<InvocationStatus, { label: string; dot: string }> = {
  ok: { label: 'Worked', dot: 'bg-success' },
  error: { label: 'Failed', dot: 'bg-danger' },
  running: { label: 'Running', dot: 'bg-accent animate-glow' },
}

export function RunStatus({ status, withLabel = false }: { status: InvocationStatus; withLabel?: boolean }) {
  const { label, dot } = STATUS[status]
  return (
    <span className="inline-flex items-center gap-2" title={label}>
      <span className={`size-2.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <span className={withLabel ? '' : 'sr-only'}>{label}</span>
    </span>
  )
}
