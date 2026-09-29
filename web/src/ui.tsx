import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { ProjectStatus } from './api.ts'

type Variant = 'primary' | 'secondary' | 'danger' | 'quiet' | 'quiet-danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:brightness-105 active:brightness-95',
  secondary: 'border border-border bg-surface-raised text-fg hover:border-muted',
  danger: 'bg-danger text-on-danger hover:brightness-110 active:brightness-95',
  quiet: 'text-muted hover:text-fg hover:bg-surface',
  'quiet-danger': 'text-danger hover:bg-danger/10',
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 text-[0.95rem] font-semibold transition-[filter,border-color,background-color,color] disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  )
}

export function Logo({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <path
        d="M16 3.2 3.6 13.1a2 2 0 0 0-.8 1.6V27a2 2 0 0 0 2 2h22.4a2 2 0 0 0 2-2V14.7a2 2 0 0 0-.8-1.6z"
        fill="var(--hw-fg)"
      />
      <circle cx="16" cy="19.5" r="5" fill="var(--hw-accent)" />
    </svg>
  )
}

const STATUS: Record<ProjectStatus, { label: string; dot: string; title: string }> = {
  ready: { label: 'Ready', dot: 'bg-success/45', title: 'Starts by itself when it is needed' },
  running: { label: 'Running', dot: 'bg-success', title: 'Running right now' },
  updating: { label: 'Updating', dot: 'bg-accent animate-glow', title: 'An agent is checking and installing a change' },
}

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const { label, dot, title } = STATUS[status]
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted" title={title}>
      <span className={`size-2 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  )
}

export function Notice({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }) {
  const styles =
    tone === 'error'
      ? 'border-danger/40 bg-danger/8 text-fg'
      : 'border-success/40 bg-success/8 text-fg'
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-4 py-3 text-[0.95rem] ${styles}`}>
      {children}
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  variant = 'primary',
  busy,
  confirmDisabled = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  variant?: 'primary' | 'danger'
  busy?: boolean
  confirmDisabled?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface-raised p-0 text-fg shadow-[0_24px_60px_-20px_rgb(0_0_0/0.45)] backdrop:bg-[rgb(10_16_14/0.55)]"
    >
      <div className="p-6">
        <h2 className="text-xl font-semibold">{title}</h2>
        <div className="mt-3 space-y-2 text-muted">{children}</div>
        {error && (
          <div className="mt-4">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={variant} onClick={onConfirm} disabled={busy || confirmDisabled} autoFocus={!confirmDisabled}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  )
}

export function PageHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <h1 className="text-[2.1rem] leading-tight font-semibold tracking-[-0.01em] sm:text-[2.6rem]">{children}</h1>
      {aside}
    </div>
  )
}
