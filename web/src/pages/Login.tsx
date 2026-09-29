import type { Session } from '../api.ts'
import { Logo, Notice } from '../ui.tsx'

const ERRORS: Record<string, string> = {
  not_allowed:
    'This account is not on the list of people who can use Hobwork. Ask the person who set up Hobwork to add your email address.',
  expired: 'Signing in took too long. Try again.',
  failed: 'Signing in did not work. Try again in a moment.',
}

export function LoginPage({ session, error, returnTo }: { session: Session; error: string | null; returnTo: string }) {
  const oidc = session.signIn.oidc
  const message = error ? (ERRORS[error] ?? ERRORS.failed) : null

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

        <div className="mt-8">
          {oidc ? (
            <a
              href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`}
              className="flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-5 text-lg font-semibold text-on-accent transition-[filter] hover:brightness-105 active:brightness-95"
            >
              Sign in with {oidc.name}
            </a>
          ) : (
            <Notice tone="error">
              There is no way to sign in yet. Whoever runs Hobwork needs to connect it to a sign-in service.
            </Notice>
          )}
        </div>
      </div>
    </main>
  )
}
