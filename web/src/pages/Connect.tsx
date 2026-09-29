import { useState, type FormEvent, type ReactNode } from 'react'
import { accessReady, FULL_ACCESS, projectsText } from '../access.ts'
import { AccessPicker } from '../AccessPicker.tsx'
import { api, ApiError, type Access, type ConnectRequest } from '../api.ts'
import { Link } from '../router.tsx'
import { Button, Logo, Notice } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'

const ERRORS: Record<string, string> = {
  unknown_client: 'Hobwork does not recognize the app that asked for access. Start connecting again from the app.',
  invalid_redirect_uri:
    'The app asked Hobwork to send you to an address it never registered, so Hobwork stopped the connection.',
  invalid_request: 'The connection request is incomplete. Start connecting again from the app.',
  too_many_requests: 'Too many apps tried to connect in a short time. Wait a few minutes, then start connecting again from the app.',
}

function abilities(access: Access): string[] {
  if (access.readOnly) {
    return ['See project files, logs and versions', 'See the names of secrets and devices', 'Read states and history from Home Assistant']
  }
  return [
    access.projects === null ? 'See, create and change your projects' : 'See and change these projects',
    'Run code and commands in project workspaces',
    'Merge changes, which puts them live',
    'Read logs and go back to earlier versions',
  ]
}

export function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-12">
      <div className="w-full max-w-md">
        <Logo className="size-11" />
        {children}
      </div>
    </main>
  )
}

function ConnectForm({ id, request }: { id: string; request: ConnectRequest }) {
  const [agentName, setAgentName] = useState(request.agentName)
  const [access, setAccess] = useState<Access>(FULL_ACCESS)
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { client } = request

  async function answer(action: 'allow' | 'deny', event?: FormEvent) {
    event?.preventDefault()
    setBusy(action)
    setError(null)
    try {
      const { redirectTo } =
        action === 'allow' ? await api.approveConnect(id, agentName.trim(), access) : await api.denyConnect(id)
      window.location.assign(redirectTo)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
      setBusy(null)
    }
  }

  return (
    <form onSubmit={(event) => answer('allow', event)}>
      <h1 className="mt-6 text-[2.1rem] leading-tight font-semibold tracking-[-0.01em]">
        Let {client.name} use Hobwork?
      </h1>
      {client.domain ? (
        <p className="mt-3 text-muted">
          {client.name} is an app from <strong className="font-semibold text-fg">{client.domain}</strong>.
        </p>
      ) : (
        <div className="mt-4">
          <Notice tone="error">
            Hobwork cannot check who made this app. Allow access only if you started connecting it yourself just now.
          </Notice>
        </div>
      )}

      <div className="mt-8">
        <AccessPicker access={access} onChange={setAccess} />
      </div>

      <section aria-labelledby="abilities" className="mt-6 rounded-lg border border-border bg-surface p-5 sm:p-6">
        <h2 id="abilities" className="text-lg font-semibold">
          It will be able to, on {access.projects === null ? 'all your projects' : projectsText(access)}:
        </h2>
        <ul className="mt-3 space-y-2">
          {abilities(access).map((ability) => (
            <li key={ability} className="flex gap-3">
              <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-accent" />
              {ability}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-muted">It cannot manage people, agents, or the values of secrets.</p>
      </section>

      <div className="mt-6">
        <label htmlFor="agent-name" className="font-semibold">
          Name in Agent access
        </label>
        <input
          id="agent-name"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          maxLength={64}
          required
          className="mt-2 min-h-10 w-full rounded-md border border-border bg-surface-raised px-3 text-fg focus:border-accent focus:outline-none"
        />
        <p className="mt-1.5 text-sm text-muted">You can take access away there at any time.</p>
      </div>

      <p className="mt-6 text-sm text-muted">
        After you answer, Hobwork sends you to <strong className="font-semibold text-fg">{request.redirectHost}</strong>.
        {request.loopback && ' That address is on this computer, so the app runs here. Continue only if you started it.'}
      </p>

      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="quiet" onClick={() => answer('deny')} disabled={busy !== null}>
          {busy === 'deny' ? 'Cancelling…' : 'Cancel'}
        </Button>
        <Button type="submit" variant="primary" disabled={busy !== null || !agentName.trim() || !accessReady(access)}>
          {busy === 'allow' ? 'Allowing…' : 'Allow access'}
        </Button>
      </div>
    </form>
  )
}

export function ConnectPage({ requestId, error }: { requestId: string | null; error: string | null }) {
  const load = useLoad(() => (requestId ? api.connectRequest(requestId) : Promise.resolve(null)), requestId ?? '')
  const message = error ? (ERRORS[error] ?? ERRORS.invalid_request) : !requestId ? ERRORS.invalid_request : load.error

  return (
    <Frame>
      {message ? (
        <>
          <h1 className="mt-6 text-[2.1rem] leading-tight font-semibold tracking-[-0.01em]">Connection stopped</h1>
          <div className="mt-6">
            <Notice tone="error">{message}</Notice>
          </div>
          <p className="mt-6">
            <Link to="/" className="rounded-sm text-muted underline decoration-border underline-offset-4 hover:text-fg">
              Go to your projects
            </Link>
          </p>
        </>
      ) : (
        load.data && requestId && <ConnectForm id={requestId} request={load.data} />
      )}
    </Frame>
  )
}
