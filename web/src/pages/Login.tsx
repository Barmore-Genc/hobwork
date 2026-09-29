import { useState } from 'react'
import { api, type Session } from '../api.ts'
import { passkeyError, passkeysSupported } from '../passkeys.ts'
import { Button, Logo, Notice } from '../ui.tsx'

const ERRORS: Record<string, string> = {
  not_allowed:
    'This account is not on the list of people who can use Hobwork. Ask the person who set up Hobwork to add your email address.',
  expired: 'Signing in took too long. Try again.',
  failed: 'Signing in did not work. Try again in a moment.',
  link_expired: 'This sign-in link expired or was already used. Ask for a new one.',
}

export function LoginPage({
  session,
  error,
  returnTo,
  onSignedIn,
}: {
  session: Session
  error: string | null
  returnTo: string
  onSignedIn: () => void
}) {
  const oidc = session.signIn.oidc
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [passkeyMessage, setPasskeyMessage] = useState<string | null>(null)
  const message = passkeyMessage ?? (error ? (ERRORS[error] ?? ERRORS.failed) : null)
  const canUsePasskey = session.signIn.passkey && passkeysSupported()

  async function signInWithPasskey() {
    setPasskeyBusy(true)
    setPasskeyMessage(null)
    try {
      await api.signInWithPasskey()
      onSignedIn()
    } catch (err) {
      setPasskeyMessage(passkeyError(err))
    } finally {
      setPasskeyBusy(false)
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Logo className="size-14" />
        <h1 className="mt-6 text-[2.75rem] leading-none font-bold tracking-[-0.03em]">Hobwork</h1>
        <p className="mt-4 text-lg text-muted">The small programs that help around the house, and the agents that build them.</p>

        {message && (
          <div className="mt-8">
            <Notice tone="error">{message}</Notice>
          </div>
        )}

        <div className="mt-8 space-y-3">
          {oidc && (
            <a
              href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
              className="flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-5 text-lg font-semibold text-on-accent transition-[filter] hover:brightness-105 active:brightness-95"
            >
              Sign in with {oidc.name}
            </a>
          )}
          {canUsePasskey && (
            <Button
              variant={oidc ? 'secondary' : 'primary'}
              onClick={signInWithPasskey}
              disabled={passkeyBusy}
              className="min-h-12 w-full text-lg"
            >
              {passkeyBusy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
            </Button>
          )}
          {!oidc && !canUsePasskey && (
            <Notice tone="error">
              This browser cannot use passkeys, and Hobwork has no other way to sign in yet. Try another browser.
            </Notice>
          )}
        </div>
      </div>
    </main>
  )
}
