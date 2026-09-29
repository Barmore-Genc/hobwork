import { useCallback, useEffect, useState } from 'react'
import { api, setSignedOutHandler, type Session } from './api.ts'
import { AgentsPage } from './pages/Agents.tsx'
import { AllActivityPage } from './pages/AllActivity.tsx'
import { ConnectPage } from './pages/Connect.tsx'
import { DeletedProjectsPage } from './pages/DeletedProjects.tsx'
import { DeviceConnectPage } from './pages/DeviceConnect.tsx'
import { HostRequestPage } from './pages/HostRequest.tsx'
import { LoginPage } from './pages/Login.tsx'
import { ProjectPage } from './pages/Project.tsx'
import { ActivityPage } from './pages/project/Activity.tsx'
import { ProjectAiPage } from './pages/project/Ai.tsx'
import { PreviewPage } from './pages/project/Branches.tsx'
import { LogPage } from './pages/project/Log.tsx'
import { ProjectAppPage } from './pages/project/ProjectApp.tsx'
import { RunPage } from './pages/project/Run.tsx'
import { ProjectsPage } from './pages/Projects.tsx'
import { ProjectSecretsPage, SecretsPage } from './pages/Secrets.tsx'
import { SettingsPage } from './pages/Settings.tsx'
import { navigate, useLocation } from './navigation.ts'
import { Shell } from './Shell.tsx'
import { Notice } from './ui.tsx'

function Page({ pathname }: { pathname: string }) {
  if (pathname === '/') return <ProjectsPage />
  if (pathname === '/activity') return <AllActivityPage />
  if (pathname === '/agents') return <AgentsPage />
  if (pathname === '/settings') return <SettingsPage />
  if (pathname === '/secrets') return <SecretsPage />
  if (pathname === '/deleted') return <DeletedProjectsPage />
  const project = /^\/projects\/([^/]+)(\/[^?]*)?$/.exec(pathname)
  if (project) {
    const name = decodeURIComponent(project[1]!)
    const rest = (project[2] ?? '').replace(/\/$/, '')
    if (rest === '') return <ProjectPage name={name} />
    if (rest === '/activity') return <ActivityPage name={name} />
    if (rest === '/log') return <LogPage name={name} />
    if (rest === '/secrets') return <ProjectSecretsPage name={name} />
    if (rest === '/ai') return <ProjectAiPage name={name} />
    if (rest === '/app') return <ProjectAppPage name={name} />
    const preview = /^\/preview\/([^/]+)$/.exec(rest)
    if (preview) return <PreviewPage name={name} branch={decodeURIComponent(preview[1]!)} />
    const run = /^\/activity\/(\d+)$/.exec(rest)
    if (run) return <RunPage name={name} id={Number(run[1])} />
  }
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold">Nothing here</h1>
      <p className="text-muted">This page does not exist. Go back to your hobs.</p>
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
    if (!session?.user || pathname !== '/login') return
    const returnTo = search.get('returnTo') ?? '/'
    // Signing in to a project app or for an NFC tag continues on the host, outside this app.
    if (returnTo.startsWith('/auth/') || returnTo.startsWith('/p/') || returnTo.startsWith('/nfc/')) window.location.replace(returnTo)
    else navigate(returnTo, { replace: true })
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
  if (pathname === '/devices/connect') return <DeviceConnectPage search={search} />
  const hostRequest = /^\/secrets\/requests\/(\d+)\/?$/.exec(pathname)
  if (hostRequest) return <HostRequestPage id={Number(hostRequest[1])} />
  return (
    <Shell user={session.user} pathname={pathname} onSignedOut={loadSession} wide={/^\/projects\/[^/]+\/(app|preview\/[^/]+)\/?$/.test(pathname)}>
      <Page pathname={pathname} />
    </Shell>
  )
}
