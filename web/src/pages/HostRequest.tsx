import { useState } from 'react'
import { api, ApiError, type HostRequest } from '../api.ts'
import { exactTime, timeAgo } from '../format.ts'
import { Link } from '../router.tsx'
import { Button, Notice } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'
import { Frame } from './Connect.tsx'

type Change = 'added' | 'removed' | 'kept'

function changes(current: string[], requested: string[]): { host: string; change: Change }[] {
  return [
    ...requested.map((host) => ({ host, change: current.includes(host) ? ('kept' as const) : ('added' as const) })),
    ...current.filter((host) => !requested.includes(host)).map((host) => ({ host, change: 'removed' as const })),
  ]
}

const MARKS: Record<Change, { sign: string; label: string; row: string; badge: string }> = {
  added: { sign: '+', label: 'New', row: 'border-accent/50 bg-accent/10', badge: 'bg-accent text-on-accent' },
  removed: { sign: '−', label: 'Removed', row: 'border-danger/40 bg-danger/8', badge: 'bg-danger text-on-danger' },
  kept: { sign: '=', label: 'Stays', row: 'border-border bg-surface', badge: 'bg-border text-fg' },
}

// The last two labels are what the site belongs to, so they stand out.
function HostName({ host, removed }: { host: string; removed: boolean }) {
  const wildcard = host.startsWith('*.')
  const labels = (wildcard ? host.slice(2) : host).split('.')
  const domain = labels.slice(-2).join('.')
  const sub = labels.slice(0, -2).join('.')
  return (
    <span className={`font-mono text-[1.05rem] break-all ${removed ? 'line-through decoration-danger/70' : ''}`}>
      {wildcard && <span className="font-semibold text-accent-fg">*.</span>}
      {sub && <span className="text-muted">{sub}.</span>}
      <span className="font-semibold text-fg">{domain}</span>
    </span>
  )
}

// Once answered, the secret's hosts may have changed since, so only the
// requested hosts are shown.
function HostList({ request }: { request: HostRequest }) {
  const rows =
    request.decision === null
      ? changes(request.secret.hosts, request.hosts)
      : request.hosts.map((host) => ({ host, change: 'kept' as const }))
  return (
    <ul className="mt-3 space-y-2" aria-label="Sites">
      {rows.map(({ host, change }) => {
        const mark = MARKS[change]
        return (
          <li key={host} className={`flex items-start gap-3 rounded-md border px-3 py-2.5 ${mark.row}`}>
            <span
              aria-label={mark.label}
              className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm font-mono text-sm font-bold ${mark.badge}`}
            >
              {mark.sign}
            </span>
            <div className="min-w-0">
              <HostName host={host} removed={change === 'removed'} />
              {host.startsWith('*.') && (
                <p className="text-sm text-muted">and every site under {host.slice(2)}</p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function Decided({ request }: { request: HostRequest }) {
  const text = {
    approved: `Approved${request.decidedBy ? ` by ${request.decidedBy}` : ''}. ${request.secret.name} is now sent only to the sites above.`,
    denied: `Denied${request.decidedBy ? ` by ${request.decidedBy}` : ''}. Nothing changed.`,
    superseded: `${request.agent ?? 'The agent'} sent a newer request for this secret, so this one no longer applies.`,
  }[request.decision!]
  return (
    <div className="mt-6">
      <Notice tone={request.decision === 'approved' ? 'success' : 'error'}>
        {text}
        {request.decidedAt && (
          <span className="text-muted" title={exactTime(request.decidedAt)}>
            {' '}
            ({timeAgo(request.decidedAt)})
          </span>
        )}
      </Notice>
    </div>
  )
}

function RequestForm({ initial }: { initial: HostRequest }) {
  const [request, setRequest] = useState(initial)
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const agent = request.agent ?? 'An agent'

  async function answer(approve: boolean) {
    setBusy(approve ? 'approve' : 'deny')
    setError(null)
    try {
      setRequest(await api.decideHostRequest(request.id, approve))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <h1 className="mt-6 text-[2.1rem] leading-tight font-semibold tracking-[-0.01em]">
        {request.decision === null ? `Send ${request.secret.name} to these sites?` : `Sites for ${request.secret.name}`}
      </h1>
      <p className="mt-3 text-muted">
        {agent} asked <span title={exactTime(request.createdAt)}>{timeAgo(request.createdAt)}</span>. Hobs send
        the secret only to the sites you approve.
      </p>

      <section aria-labelledby="reason" className="mt-6 rounded-lg border border-border bg-surface p-4">
        <h2 id="reason" className="text-sm font-semibold text-muted">
          Why
        </h2>
        <p className="mt-1 break-words">{request.reason}</p>
      </section>

      <section aria-labelledby="sites" className="mt-6">
        <h2 id="sites" className="text-lg font-semibold">
          {request.decision === null ? 'Sites it may be sent to' : 'Sites asked for'}
        </h2>
        <HostList request={request} />
      </section>

      {request.decision ? (
        <Decided request={request} />
      ) : (
        <>
          {error && (
            <div className="mt-4">
              <Notice tone="error">{error}</Notice>
            </div>
          )}
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="quiet" onClick={() => answer(false)} disabled={busy !== null}>
              {busy === 'deny' ? 'Denying…' : 'Deny'}
            </Button>
            <Button variant="primary" onClick={() => answer(true)} disabled={busy !== null}>
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </Button>
          </div>
        </>
      )}

      <p className="mt-8">
        <Link to="/secrets" className="rounded-sm text-muted underline decoration-border underline-offset-4 hover:text-fg">
          Go to secrets
        </Link>
      </p>
    </>
  )
}

export function HostRequestPage({ id }: { id: number }) {
  const load = useLoad(() => api.hostRequest(id), String(id))
  return (
    <Frame>
      {load.error ? (
        <>
          <h1 className="mt-6 text-[2.1rem] leading-tight font-semibold tracking-[-0.01em]">Request not found</h1>
          <div className="mt-6">
            <Notice tone="error">{load.error}</Notice>
          </div>
        </>
      ) : (
        load.data && <RequestForm initial={load.data} />
      )}
    </Frame>
  )
}
