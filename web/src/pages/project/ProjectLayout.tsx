import { useEffect, useState, type ReactNode } from 'react'
import { api, type ProjectDetail } from '../../api.ts'
import { navigate, useLocation } from '../../navigation.ts'
import { Link } from '../../router.tsx'
import { Notice, PageHeading, ProjectIcon, StarIcon, StatusBadge } from '../../ui.tsx'
import { useLoad } from '../../useLoad.ts'
import { projectChanged } from '../../live.ts'
import { projectPath } from './names.ts'
import { ProjectTags } from './ProjectTags.tsx'

export type ProjectTab = 'overview' | 'activity' | 'log' | 'secrets' | 'ai' | 'home-assistant' | 'app'

const TABS: { tab: ProjectTab; label: string; path: string }[] = [
  { tab: 'overview', label: 'Overview', path: '' },
  { tab: 'activity', label: 'Activity', path: '/activity' },
  { tab: 'log', label: 'Log', path: '/log' },
  { tab: 'secrets', label: 'Secrets', path: '/secrets' },
  { tab: 'ai', label: 'AI', path: '/ai' },
  { tab: 'home-assistant', label: 'Home Assistant', path: '/home-assistant' },
]

// Heading, status and tabs shared by every project page. The page itself gets
// the loaded project.
export function ProjectLayout({
  name,
  tab,
  children,
}: {
  name: string
  tab: ProjectTab
  children: (project: ProjectDetail, reload: () => void) => ReactNode
}) {
  const { data: project, error, reload } = useLoad(() => api.project(name), name, projectChanged(name))
  const { pathname, search } = useLocation()

  // A link with the old name of a renamed project loads the project under its new name.
  useEffect(() => {
    if (!project || project.name === name) return
    const prefix = projectPath(name)
    const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
    const query = search.toString()
    navigate(`${projectPath(project.name, rest)}${query ? `?${query}` : ''}`, { replace: true })
  }, [project, name, pathname, search])
  if (project && project.name !== name) return null

  return (
    <div>
      <Link to="/" className="text-sm text-muted hover:text-fg">
        All hobs
      </Link>
      <div className="mt-3">
        <PageHeading
          aside={
            project && (
              <div className="flex items-center gap-4">
                <StatusBadge status={project.status} />
                {project.app && tab !== 'app' && (
                  <Link
                    to={projectPath(name, '/app')}
                    className="inline-flex min-h-10 items-center rounded-md bg-accent px-4 text-[0.95rem] font-semibold text-on-accent hover:brightness-105"
                  >
                    Open app
                  </Link>
                )}
              </div>
            )
          }
        >
          <span className="flex items-center gap-4">
            {project && <ProjectIcon src={project.iconUrl} className="size-12" />}
            {name}
            {project && <StarButton project={project.name} starred={project.starred} onChanged={reload} />}
          </span>
        </PageHeading>
        {project && tab === 'overview' && <ProjectTags project={project.name} tags={project.tags} onChanged={reload} />}
      </div>
      <nav aria-label={`${name} sections`} className="mt-6 overflow-x-auto border-b border-border">
        <ul className="flex gap-1">
          {TABS.map((item) => {
            const active = item.tab === tab
            return (
              <li key={item.tab}>
                <Link
                  to={projectPath(name, item.path)}
                  aria-current={active ? 'page' : undefined}
                  className={`relative block px-3 pt-1 pb-2.5 whitespace-nowrap transition-colors ${
                    active ? 'font-semibold text-fg' : 'text-muted hover:text-fg'
                  }`}
                >
                  {item.label}
                  {active && (
                    <span aria-hidden="true" className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-accent" />
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
      {error && (
        <div className="mt-8">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {project && children(project, reload)}
    </div>
  )
}

function StarButton({ project, starred, onChanged }: { project: string; starred: boolean; onChanged: () => void }) {
  // Shows the change right away, until the project loads again.
  const [pending, setPending] = useState<{ was: boolean; on: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const on = pending?.was === starred ? pending.on : starred
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`Star ${project}`}
      title={error ?? (on ? 'Starred, shown at the top of your hobs' : 'Star to show it at the top of your hobs')}
      onClick={() => {
        setPending({ was: starred, on: !on })
        setError(null)
        api.starProject(project, !on).then(onChanged, (err: unknown) => {
          setPending(null)
          setError(err instanceof Error ? err.message : String(err))
        })
      }}
      className={`flex size-10 items-center justify-center rounded-md hover:bg-surface ${on ? 'text-accent-fg' : 'text-muted hover:text-fg'}`}
    >
      <StarIcon filled={on} />
    </button>
  )
}
