import { useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError, type PairingRequest } from '../api.ts'
import { Link } from '../router.tsx'
import { Button, Logo, Notice } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'

const PLATFORM_NAMES: Record<PairingRequest['platform'], string> = { ios: 'iPhone or iPad', macos: 'Mac' }

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-12">
      <div className="w-full max-w-md">
        <Logo className="size-11" />
        {children}
      </div>
    </main>
  )
}

function ConnectForm({ query, request }: { query: Record<string, string>; request: PairingRequest }) {
  const [name, setName] = useState(request.name)
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function answer(action: 'allow' | 'deny', event?: FormEvent) {
    event?.preventDefault()
    setBusy(action)
    setError(null)
    try {
      const { redirectTo } = action === 'allow' ? await api.approvePairing(query, name.trim()) : await api.denyPairing(query)
      setDone(true)
      window.location.assign(redirectTo)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
      setBusy(null)
    }
  }

  if (done) {
    return (
      <>
        <h1 className="mt-6 text-[2.1rem] leading-tight font-semibold tracking-[-0.01em]">Back to the app</h1>
        <p className="mt-3 text-muted">Continue in the Hobwork app on your {PLATFORM_NAMES[request.platform]}.</p>
      </>
    )
  }

  return (
    <form onSubmit={(event) => answer('allow', event)}>
      <h1 className="mt-6 text-[2.1rem] leading-tight font-semibold tracking-[-0.01em] break-words">
        Connect {request.displayName}?
      </h1>
      <p className="mt-3 text-muted">
        The Hobwork app on this {PLATFORM_NAMES[request.platform]} will open your hobs signed in as you, and your
        hobs can send it notifications.
      </p>

      <div className="mt-6">
        <label htmlFor="device-name" className="font-semibold">
          Name in hobs
        </label>
        <input
          id="device-name"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          maxLength={40}
          pattern="[a-z0-9][a-z0-9\-]*"
          required
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="mt-2 min-h-10 w-full rounded-md border border-border bg-surface-raised px-3 font-mono text-fg focus:border-accent focus:outline-none"
        />
        <p className="mt-1.5 text-sm text-muted">
          Lowercase letters, digits and hyphens. You can rename or remove the device in Settings at any time.
        </p>
      </div>

      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="quiet" onClick={() => answer('deny')} disabled={busy !== null}>
          {busy === 'deny' ? 'Cancelling…' : 'Cancel'}
        </Button>
        <Button type="submit" variant="primary" disabled={busy !== null || !name.trim()}>
          {busy === 'allow' ? 'Connecting…' : 'Connect device'}
        </Button>
      </div>
    </form>
  )
}

// Opened by the Hobwork app to pair a device (see "Device protocol" in docs/architecture.md).
export function DeviceConnectPage({ search }: { search: URLSearchParams }) {
  const queryString = search.toString()
  const load = useLoad(() => api.pairingRequest(queryString), queryString)
  const query = Object.fromEntries(search)

  return (
    <Frame>
      {load.error ? (
        <>
          <h1 className="mt-6 text-[2.1rem] leading-tight font-semibold tracking-[-0.01em]">Connection stopped</h1>
          <div className="mt-6">
            <Notice tone="error">{load.error.replace(/\.?$/, '.')} Start connecting again from the Hobwork app.</Notice>
          </div>
          <p className="mt-6">
            <Link to="/" className="rounded-sm text-muted underline decoration-border underline-offset-4 hover:text-fg">
              Go to your hobs
            </Link>
          </p>
        </>
      ) : (
        load.data && <ConnectForm query={query} request={load.data} />
      )}
    </Frame>
  )
}
