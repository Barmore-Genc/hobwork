import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, type HomeAssistantSettings, type HomeAssistantTest } from '../../api.ts'
import { exactTime, timeAgo } from '../../format.ts'
import { Button, ConfirmDialog, Notice } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'

const inputClass =
  'mt-2 min-h-10 w-full rounded-md border border-border bg-surface-raised px-3 font-mono text-sm text-fg placeholder:font-sans placeholder:text-muted/70 focus:border-accent focus:outline-none'

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

function Status({ settings }: { settings: HomeAssistantSettings }) {
  const { status, version, lastError } = settings
  const dot =
    status === 'connected'
      ? 'bg-success'
      : status === 'connecting'
        ? 'bg-accent animate-glow'
        : status === 'disconnected'
          ? 'bg-danger'
          : 'bg-border'
  const text =
    status === 'connected'
      ? `Connected${version ? ` to Home Assistant ${version}` : ''}`
      : status === 'connecting'
        ? 'Connecting…'
        : status === 'disconnected'
          ? 'Not connected'
          : 'Not connected yet'
  return (
    <div className="flex items-start gap-3">
      <span className={`mt-2 size-2.5 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold">{text}</p>
        {status === 'disconnected' && lastError && (
          <p className="text-sm break-words text-danger">
            {lastError === 'access token rejected' ? 'Home Assistant did not accept the access token' : lastError}.
            Hobwork keeps trying in the background.
          </p>
        )}
        {settings.url && <p className="font-mono text-sm break-all text-muted">{settings.url}</p>}
        {settings.source === 'settings' && settings.updatedAt && (
          <p className="text-sm text-muted">
            Set up <span title={exactTime(settings.updatedAt)}>{timeAgo(settings.updatedAt)}</span>
            {settings.updatedBy && ` by ${settings.updatedBy}`}
          </p>
        )}
      </div>
    </div>
  )
}

function TestResult({ result }: { result: HomeAssistantTest }) {
  return (
    <Notice tone={result.ok ? 'success' : 'error'}>
      {result.ok
        ? `Hobwork can reach Home Assistant${result.version ? ` ${result.version}` : ''} with this token.`
        : result.error}
    </Notice>
  )
}

function ConnectionForm({
  current,
  onChanged,
}: {
  current: HomeAssistantSettings
  onChanged: () => void
}) {
  const [url, setUrl] = useState(current.url ?? '')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'disconnect' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tested, setTested] = useState<HomeAssistantTest | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const addressChanged = current.url !== null && url.trim().replace(/\/$/, '') !== current.url
  const needsToken = !current.tokenSet || addressChanged
  const ready = url.trim() !== '' && (!needsToken || token !== '')

  async function run(kind: 'save' | 'test' | 'disconnect', action: () => Promise<void>) {
    setBusy(kind)
    setError(null)
    setTested(null)
    try {
      await action()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(null)
    }
  }

  function save(event: FormEvent) {
    event.preventDefault()
    void run('save', async () => {
      await api.saveHomeAssistant({ url, ...(token ? { token } : {}) })
      setToken('')
      onChanged()
    })
  }

  return (
    <form onSubmit={save} className="mt-6 space-y-5 border-t border-border pt-6">
      <div>
        <label htmlFor="ha-url" className="font-semibold">
          Address
        </label>
        <p className="text-sm text-muted">Where you open Home Assistant in the browser.</p>
        <input
          id="ha-url"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://homeassistant.local:8123"
          required
          autoComplete="off"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="ha-token" className="font-semibold">
          Long-lived access token
        </label>
        <p className="text-sm text-muted">
          Create one in Home Assistant: open your profile, then Security, then Long-lived access tokens.
        </p>
        <input
          id="ha-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={needsToken ? 'Paste the token' : 'Saved. Paste a new one to replace it'}
          required={needsToken}
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
        {addressChanged && current.tokenSet && (
          <p className="mt-1 text-sm text-muted">Paste the token again for the new address.</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy !== null || !ready}>
          {busy === 'save' ? 'Connecting…' : current.tokenSet ? 'Save and reconnect' : 'Save and connect'}
        </Button>
        <Button
          onClick={() => run('test', async () => setTested(await api.testHomeAssistant({ url, ...(token ? { token } : {}) })))}
          disabled={busy !== null || !ready}
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </Button>
        {current.source === 'settings' && (
          <Button
            variant="quiet-danger"
            className="sm:ml-auto"
            onClick={() => {
              setError(null)
              setConfirmDisconnect(true)
            }}
            disabled={busy !== null}
          >
            Disconnect
          </Button>
        )}
      </div>
      {tested && <TestResult result={tested} />}
      {error && !confirmDisconnect && <Notice tone="error">{error}</Notice>}

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect Home Assistant?"
        confirmLabel="Disconnect"
        variant="danger"
        busy={busy === 'disconnect'}
        error={error}
        onConfirm={() =>
          run('disconnect', async () => {
            await api.disconnectHomeAssistant()
            setConfirmDisconnect(false)
            onChanged()
          })
        }
        onCancel={() => setConfirmDisconnect(false)}
      >
        <p>
          Hobs can no longer read or control your home, and they stop running when something happens at home. Hobwork
          forgets the access token.
        </p>
      </ConfirmDialog>
    </form>
  )
}

// Set in the server configuration, so it can only be tested here.
function ServerConnection() {
  const [busy, setBusy] = useState(false)
  const [tested, setTested] = useState<HomeAssistantTest | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="mt-5 space-y-4">
      <p className="max-w-prose text-sm text-muted">
        Whoever runs your Hobwork server set up this connection in its configuration, so it is changed there.
      </p>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          try {
            setTested(await api.testHomeAssistant({}))
          } catch (err) {
            setError(message(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Testing…' : 'Test connection'}
      </Button>
      {tested && <TestResult result={tested} />}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  )
}

export function HomeAssistantSection() {
  const { data: current, error, reload } = useLoad(api.homeAssistant)

  // Shows the connection settling after a save, or while it retries.
  const connecting = current?.status === 'connecting'
  useEffect(() => {
    if (!connecting) return
    const timer = setTimeout(reload, 2000)
    return () => clearTimeout(timer)
  }, [connecting, reload])

  return (
    <section aria-labelledby="homeassistant" className="mt-14">
      <h2 id="homeassistant" className="text-2xl font-semibold">
        Home Assistant
      </h2>
      <p className="mt-2 max-w-prose text-muted">
        Hobs use Home Assistant to run when something happens at home and to control your devices.
      </p>

      {error && (
        <div className="mt-6">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {current && (
        <div className="mt-6 rounded-lg border border-border bg-surface p-5 sm:p-6">
          <Status settings={current} />
          {current.source === 'env' ? (
            <ServerConnection />
          ) : (
            <ConnectionForm key={`${current.url}|${current.updatedAt}`} current={current} onChanged={reload} />
          )}
        </div>
      )}
    </section>
  )
}
