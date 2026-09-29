import { useState, type FormEvent } from 'react'
import { api, ApiError, type Passkey } from '../api.ts'
import { exactTime, shortDate, timeAgo } from '../format.ts'
import { deviceName, passkeyError, passkeysSupported } from '../passkeys.ts'
import { Button, ConfirmDialog, Notice, PageHeading } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'
import { BackupSettings } from './BackupSettings.tsx'
import { AiSection } from './settings/Ai.tsx'
import { DevicesSection } from './settings/Devices.tsx'
import { HomeAssistantSection } from './settings/HomeAssistant.tsx'

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

function RenameForm({ passkey, onDone }: { passkey: Passkey; onDone: (renamed: boolean) => void }) {
  const [name, setName] = useState(passkey.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.renamePasskey(passkey.id, name.trim())
      onDone(true)
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="mt-3 space-y-3">
      <label htmlFor={`passkey-${passkey.id}-name`} className="sr-only">
        Passkey name
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id={`passkey-${passkey.id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          required
          autoFocus
          className="min-h-10 flex-1 rounded-md border border-border bg-surface-raised px-3 text-fg focus:border-accent focus:outline-none"
        />
        <div className="flex gap-3">
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || name.trim() === passkey.name}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="quiet" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  )
}

export function SettingsPage() {
  const { data: passkeys, error, reload } = useLoad(api.passkeys)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Passkey | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const supported = passkeysSupported()

  async function add(event: FormEvent) {
    event.preventDefault()
    setAdding(true)
    setAddError(null)
    setAdded(null)
    try {
      const passkey = await api.addPasskey(name.trim(), deviceName())
      setAdded(passkey.name)
      setName('')
      reload()
    } catch (err) {
      setAddError(passkeyError(err))
    } finally {
      setAdding(false)
    }
  }

  async function remove() {
    if (!removing) return
    setRemoveBusy(true)
    setRemoveError(null)
    try {
      await api.deletePasskey(removing.id)
      setRemoving(null)
      reload()
    } catch (err) {
      setRemoveError(message(err))
    } finally {
      setRemoveBusy(false)
    }
  }

  return (
    <div>
      <PageHeading>Settings</PageHeading>

      <section aria-labelledby="passkeys" className="mt-10">
        <h2 id="passkeys" className="text-2xl font-semibold">
          Passkeys
        </h2>
        <p className="mt-2 max-w-prose text-muted">
          Sign in with your fingerprint, face or device PIN. Each device or password manager you add gets its own
          passkey.
        </p>

        {passkeys && passkeys.length === 0 && (
          <p className="mt-4 font-semibold">You have no passkey yet.</p>
        )}

        <form onSubmit={add} className="mt-6 rounded-lg border border-border bg-surface p-5 sm:p-6">
          <label htmlFor="passkey-name" className="font-display text-lg font-semibold">
            Add a passkey
          </label>
          <p className="mt-1 text-sm text-muted">
            Name it after the device or password manager that keeps it, or leave the name empty to have Hobwork pick one.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              id="passkey-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              placeholder="Name (optional)"
              disabled={!supported}
              className="min-h-10 flex-1 rounded-md border border-border bg-surface-raised px-3 text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none"
            />
            <Button type="submit" variant="primary" disabled={!supported || adding}>
              {adding ? 'Waiting for your device…' : 'Add passkey'}
            </Button>
          </div>
          {!supported && (
            <div className="mt-4">
              <Notice tone="error">This browser cannot create passkeys. Try another browser or device.</Notice>
            </div>
          )}
          {addError && (
            <div className="mt-4">
              <Notice tone="error">{addError}</Notice>
            </div>
          )}
          {added && (
            <div className="mt-4">
              <Notice tone="success">Added “{added}”. Next time, choose “Sign in with a passkey”.</Notice>
            </div>
          )}
        </form>

        {error && (
          <div className="mt-6">
            <Notice tone="error">{error}</Notice>
          </div>
        )}

        {passkeys && passkeys.length > 0 && (
          <ul className="mt-6 divide-y divide-border border-y border-border">
            {passkeys.map((passkey) => (
              <li key={passkey.id} className="py-4">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <p className="font-semibold break-words">{passkey.name}</p>
                    <p className="text-sm text-muted">
                      Added <span title={exactTime(passkey.createdAt)}>{shortDate(passkey.createdAt)}</span>
                      {' · '}
                      {passkey.lastUsedAt ? (
                        <span title={exactTime(passkey.lastUsedAt)}>last used {timeAgo(passkey.lastUsedAt)}</span>
                      ) : (
                        'not used yet'
                      )}
                    </p>
                  </div>
                  {renaming !== passkey.id && (
                    <div className="flex gap-1">
                      <Button variant="quiet" onClick={() => setRenaming(passkey.id)}>
                        Rename
                      </Button>
                      <Button
                        variant="quiet-danger"
                        onClick={() => {
                          setRemoveError(null)
                          setRemoving(passkey)
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>
                {renaming === passkey.id && (
                  <RenameForm
                    passkey={passkey}
                    onDone={(renamed) => {
                      setRenaming(null)
                      if (renamed) reload()
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <DevicesSection />

      <HomeAssistantSection />

      <AiSection />

      <BackupSettings />

      <ConfirmDialog
        open={removing !== null}
        title="Remove this passkey?"
        confirmLabel="Remove passkey"
        variant="danger"
        busy={removeBusy}
        error={removeError}
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      >
        <p>“{removing?.name}” will no longer sign you in to Hobwork. You can add it again later.</p>
      </ConfirmDialog>
    </div>
  )
}
