import { useState, type ReactNode } from 'react'
import { api, type SessionUser } from './api.ts'
import { Link } from './router.tsx'
import { Logo } from './ui.tsx'

type NavItem = { to: string; label: string; match: (pathname: string) => boolean }

const NAV: NavItem[] = [
  { to: '/', label: 'Projects', match: (p) => p === '/' || p.startsWith('/projects/') },
  { to: '/secrets', label: 'Secrets', match: (p) => p.startsWith('/secrets') },
  { to: '/agents', label: 'Agent access', match: (p) => p.startsWith('/agents') },
  { to: '/settings', label: 'Settings', match: (p) => p.startsWith('/settings') },
]

export function Shell({
  user,
  pathname,
  onSignedOut,
  wide = false,
  children,
}: {
  user: SessionUser
  pathname: string
  onSignedOut: () => void
  // For pages that show a project's app, which needs the room.
  wide?: boolean
  children: ReactNode
}) {
  const [signingOut, setSigningOut] = useState(false)

  async function signOut() {
    setSigningOut(true)
    try {
      await api.signOut()
    } finally {
      onSignedOut()
    }
  }

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      {/* The header stretches to the full grid row, so its background reaches
          the bottom of long pages, while the inner column stays in view. */}
      <header className="border-b border-border bg-surface md:border-r md:border-b-0">
        <div className="md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
          <div className="flex items-center justify-between gap-4 px-4 pt-4 pb-3 md:block md:px-6 md:pt-7 md:pb-8">
            <Link to="/" className="inline-flex items-center gap-2.5 rounded-sm">
              <Logo className="size-7" />
              <span className="font-display text-[1.45rem] font-bold tracking-[-0.02em]">Hobwork</span>
            </Link>
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className="rounded-sm text-sm text-muted hover:text-fg md:hidden"
            >
              Sign out
            </button>
          </div>
          <nav aria-label="Main" className="overflow-x-auto px-2 pb-2 md:flex-1 md:px-3">
            <ul className="flex gap-1 md:flex-col">
              {NAV.map((item) => {
                const active = item.match(pathname)
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      aria-current={active ? 'page' : undefined}
                      className={`relative block rounded-md px-3 py-2 whitespace-nowrap transition-colors ${
                        active ? 'bg-bg font-semibold text-fg' : 'text-muted hover:bg-bg/60 hover:text-fg'
                      }`}
                    >
                      {active && (
                        <span
                          aria-hidden="true"
                          className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent md:inset-x-auto md:inset-y-2 md:left-0 md:h-auto md:w-0.5"
                        />
                      )}
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>
          <div className="hidden border-t border-border px-6 py-5 md:block">
            <p className="truncate font-semibold">{user.name}</p>
            {user.email && <p className="truncate text-sm text-muted">{user.email}</p>}
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className="mt-3 rounded-sm text-sm text-muted underline decoration-border underline-offset-4 hover:text-fg hover:decoration-muted"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="px-4 pt-8 pb-20 sm:px-8 md:px-12 md:pt-14">
        <div className={wide ? 'max-w-6xl' : 'max-w-3xl'}>{children}</div>
      </main>
    </div>
  )
}
