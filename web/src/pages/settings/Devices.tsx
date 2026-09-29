import { useState, type FormEvent } from 'react'
import { api, ApiError, type Device } from '../../api.ts'
import { exactTime, shortDate, timeAgo } from '../../format.ts'
import { Button, ConfirmDialog, Notice } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'

const CAPABILITY_NAMES: Record<string, string> = {
  notifications: 'Notifications',
  alarms: 'Alarms',
  screenTime: 'Screen Time',
  focus: 'Focus',
  nfc: 'NFC',
  health: 'Health',
}
const PLATFORM_NAMES: Record<Device['platform'], string> = { ios: 'iPhone or iPad', macos: 'Mac' }

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err)
}

function RenameForm({ device, onDone }: { device: Device; onDone: (renamed: boolean) => void }) {
  const [name, setName] = useState(device.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.renameDevice(device.id, name.trim())
      onDone(true)
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="mt-3 space-y-3">
      <label htmlFor={`device-${device.id}-name`} className="sr-only">
        Name in projects
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          id={`device-${device.id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          maxLength={40}
          required
          autoFocus
          autoCapitalize="none"
          spellCheck={false}
          className="min-h-10 flex-1 rounded-md border border-border bg-surface-raised px-3 font-mono text-fg focus:border-accent focus:outline-none"
        />
        <div className="flex gap-3">
          <Button type="submit" variant="primary" disabled={busy || !name.trim() || name.trim() === device.name}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="quiet" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted">Projects that use the old name stop reaching this device until they are changed.</p>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  )
}

function DeviceRow({
  device,
  onRename,
  onRemove,
  renaming,
}: {
  device: Device
  renaming: boolean
  onRename: (renaming: boolean, changed?: boolean) => void
  onRemove: () => void
}) {
  const capabilities = device.capabilities.map((c) => CAPABILITY_NAMES[c] ?? c)
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2.5">
            <span
              className={`size-2.5 shrink-0 rounded-full ${device.connected ? 'bg-success' : 'bg-border'}`}
              aria-hidden="true"
            />
            <span className="font-mono font-semibold break-all">{device.name}</span>
            <span className="sr-only">{device.connected ? '(connected)' : '(not connected)'}</span>
          </p>
          <p className="text-sm text-muted">
            {PLATFORM_NAMES[device.platform]} of {device.owner}
            {!device.ownerAllowed && ', who can no longer sign in, so projects cannot reach it'}
            {' · '}
            {device.connected ? (
              'connected now'
            ) : device.lastSeenAt ? (
              <span title={exactTime(device.lastSeenAt)}>last seen {timeAgo(device.lastSeenAt)}</span>
            ) : (
              'not connected yet'
            )}
          </p>
          <p className="text-sm text-muted">
            {capabilities.length ? capabilities.join(', ') : 'No capabilities yet'}
            {device.capabilities.includes('notifications') && !device.push && !device.connected && (
              <> · notifications arrive only while the app is open</>
            )}
            {' · '}
            added <span title={exactTime(device.createdAt)}>{shortDate(device.createdAt)}</span>
            {device.appVersion && ` · app ${device.appVersion}`}
          </p>
        </div>
        {!renaming && (
          <div className="flex gap-1">
            <Button variant="quiet" onClick={() => onRename(true)}>
              Rename
            </Button>
            <Button variant="quiet-danger" onClick={onRemove}>
              Remove
            </Button>
          </div>
        )}
      </div>
      {renaming && <RenameForm device={device} onDone={(changed) => onRename(false, changed)} />}
    </li>
  )
}

export function DevicesSection() {
  const { data, error, reload } = useLoad(api.devices)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [removing, setRemoving] = useState<Device | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  async function remove() {
    if (!removing) return
    setRemoveBusy(true)
    setRemoveError(null)
    try {
      await api.revokeDevice(removing.id)
      setRemoving(null)
      reload()
    } catch (err) {
      setRemoveError(message(err))
    } finally {
      setRemoveBusy(false)
    }
  }

  return (
    <section aria-labelledby="devices" className="mt-14">
      <h2 id="devices" className="text-2xl font-semibold">
        Devices
      </h2>
      <p className="mt-2 max-w-prose text-muted">
        Phones and computers with the Hobwork app. Projects reach them by name, for example to send a notification. To
        add one, open the Hobwork app on it and connect to this Hobwork.
      </p>

      {error && (
        <div className="mt-6">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {data && data.devices.length === 0 && <p className="mt-4 font-semibold">No devices yet.</p>}

      {data && data.devices.length > 0 && (
        <ul className="mt-6 divide-y divide-border border-y border-border">
          {data.devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              renaming={renaming === device.id}
              onRename={(on, changed) => {
                setRenaming(on ? device.id : null)
                if (changed) reload()
              }}
              onRemove={() => {
                setRemoveError(null)
                setRemoving(device)
              }}
            />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove this device?"
        confirmLabel="Remove device"
        variant="danger"
        busy={removeBusy}
        error={removeError}
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      >
        <p>
          The Hobwork app on “{removing?.name}” is signed out right away, and projects can no longer reach the device. To
          use it again, connect it from the Hobwork app.
        </p>
      </ConfirmDialog>
    </section>
  )
}
