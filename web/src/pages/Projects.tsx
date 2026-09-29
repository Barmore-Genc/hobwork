import { api } from '../api.ts'
import { exactTime, timeAgo } from '../format.ts'
import { Link } from '../router.tsx'
import { Notice, PageHeading, StatusBadge } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'

export function ProjectsPage() {
  const { data: projects, error } = useLoad(api.projects)

  return (
    <div>
      <PageHeading>Projects</PageHeading>
      <p className="mt-3 max-w-prose text-muted">Everything your agents have built for the house, and the version each one is running.</p>

      <div className="mt-10">
        {error && <Notice tone="error">{error}</Notice>}
        {projects?.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-6 py-10">
            <h2 className="text-xl font-semibold">No projects yet</h2>
            <p className="mt-2 max-w-prose text-muted">
              Projects are made by agents. Give an agent access on the{' '}
              <Link to="/agents" className="font-semibold text-accent-fg underline underline-offset-4">
                Agent access
              </Link>{' '}
              page, then ask it to build something.
            </p>
          </div>
        )}
        {projects && projects.length > 0 && (
          <ul className="divide-y divide-border border-y border-border">
            {projects.map((project) => (
              <li key={project.name}>
                <Link
                  to={`/projects/${encodeURIComponent(project.name)}`}
                  className="group grid gap-x-6 gap-y-1 px-1 py-5 sm:grid-cols-[1fr_auto] sm:items-baseline"
                >
                  <div className="min-w-0">
                    <h2 className="text-[1.45rem] leading-snug font-semibold tracking-[-0.01em] group-hover:text-accent-fg">
                      {project.name}
                    </h2>
                    <p className="mt-1 truncate text-muted">
                      {project.currentVersion?.summary ?? 'No versions yet'}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-1">
                    <StatusBadge status={project.status} />
                    {project.currentVersion && (
                      <span className="text-sm text-muted tabular" title={exactTime(project.currentVersion.createdAt)}>
                        Version {project.currentVersion.number}, {timeAgo(project.currentVersion.createdAt)}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
