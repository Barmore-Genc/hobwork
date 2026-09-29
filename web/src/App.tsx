import { useCallback, useEffect, useState } from 'react'
import { api, setSignedOutHandler, type Session } from './api.ts'
import { AgentsPage } from './pages/Agents.tsx'
import { ConnectPage } from './pages/Connect.tsx'
import { LoginPage } from './pages/Login.tsx'
import { ProjectPage } from './pages/Project.tsx'
import { ProjectsPage } from './pages/Projects.tsx'
import { SettingsPage } from './pages/Settings.tsx'
import { navigate, useLocation } from './navigation.ts'
import { Shell } from './Shell.tsx'
import { Notice } from './ui.tsx'

function Page({ pathname }: { pathname: string }) {
  if (pathname === '/') return <ProjectsPage />
  if (pathname === '/agents') return <AgentsPage />
  if (pathname === '/settings') return <SettingsPage />
  const project = /^\/projects\/([^/]+)\/?$/.exec(pathname)
  if (project) return <ProjectPage name={decodeURIComponent(project[1]!)} />
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold">Nothing here</h1>
      <p className="text-muted">This page does not exist. Go back to your projects.</p>
    </div>
  )
}

export default function App() {
  const { pathname, search } = useLocation()
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadSession = useCallback(() => {
    api.session().then(
      (s) => {
        setSession(s)
        setError(null)
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    )
  }, [])

  useEffect(loadSession, [loadSession])
  useEffect(() => setSignedOutHandler(loadSession), [loadSession])

  useEffect(() => {
    if (session?.user && pathname === '/login') navigate(search.get('returnTo') ?? '/', { replace: true })
  }, [session, pathname, search])

  if (error) {
    return (
      <main className="mx-auto max-w-md px-4 pt-24">
        <Notice tone="error">{error}</Notice>
      </main>
    )
  }
  if (!session) return null
  // The consent page for connecting an app, with or without a pending request.
  // Errors show before sign-in, since there is nothing to approve.
  const connect = pathname === '/connect'
  if (connect && search.get('error')) return <ConnectPage requestId={null} error={search.get('error')} />
  if (!session.user) {
    const returnTo = pathname === '/login' ? (search.get('returnTo') ?? '/') : `${pathname}${window.location.search}`
    return <LoginPage session={session} error={search.get('error')} returnTo={returnTo} onSignedIn={loadSession} />
  }
  if (connect) return <ConnectPage requestId={search.get('request')} error={null} />
  return (
    <Shell user={session.user} pathname={pathname} onSignedOut={loadSession}>
      <Page pathname={pathname} />
    </Shell>
  )
}
