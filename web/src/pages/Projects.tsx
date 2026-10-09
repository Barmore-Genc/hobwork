import { useEffect, useRef, useState } from 'react'
import { api, type ProjectSummary, type StorageUse } from '../api.ts'
import { useLocation } from '../navigation.ts'
import { bytes, exactTime, timeAgo } from '../format.ts'
import { Link } from '../router.tsx'
import { Notice, PageHeading, ProjectIcon, StatusBadge } from '../ui.tsx'
import { useLoad } from '../useLoad.ts'
import { kindChanged, projectsChanged } from '../live.ts'
import { HobList } from './HobList.tsx'

const SEARCH_DELAY_MS = 200

export function ProjectsPage() {
  const location = useLocation()
  const deleted = location.search.get('deleted')
  const [input, setInput] = useState(() => location.search.get('q') ?? '')
  const [query, setQuery] = useState(input)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [input])
  // Kept in the address so going back to the list shows the same search.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (query) url.searchParams.set('q', query)
    else url.searchParams.delete('q')
    history.replaceState(history.state, '', url)
  }, [query])

  const { data: projects, error, reload } = useLoad(() => api.projects(query), query, projectsChanged)
  const { data: tags } = useLoad(api.tags, '', kindChanged('projects'))
  const [actionError, setActionError] = useState<string | null>(null)
  const searching = query !== ''

  function toggleTag(tag: string) {
    const term = `tag:${tag}`
    const terms = input.split(/\s+/).filter(Boolean)
    setInput((terms.includes(term) ? terms.filter((t) => t !== term) : [...terms, term]).join(' '))
  }

  return (
    <div>
      <PageHeading>Hobs</PageHeading>
      <p className="mt-3 max-w-prose text-muted">Everything your agents have built for the house, and the version each one is running.</p>

      <div className="mt-10 space-y-6">
        {deleted && (
          <Notice tone="success">
            Deleted {deleted}. You can restore it from{' '}
            <Link to="/deleted" className="font-semibold underline underline-offset-4">
              Deleted hobs
            </Link>{' '}
            for 7 days.
          </Notice>
        )}
        {(projects?.length || searching) && (
          <SearchBox value={input} onChange={setInput} tags={tags ?? []} onToggleTag={toggleTag} />
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {actionError && <Notice tone="error">{actionError}</Notice>}
        {projects?.length === 0 && !searching && (
          <div className="rounded-lg border border-dashed border-border px-6 py-10">
            <h2 className="text-xl font-semibold">No hobs yet</h2>
            <p className="mt-2 max-w-prose text-muted">
              Hobs are made by agents. Give an agent access on the{' '}
              <Link to="/agents" className="font-semibold text-accent-fg underline underline-offset-4">
                Agent access
              </Link>{' '}
              page, then ask it to build something.
            </p>
          </div>
        )}
        {projects?.length === 0 && searching && <p className="text-muted">No hobs match this search.</p>}
        {projects && projects.length > 0 && (
          <HobList
            projects={projects}
            searching={searching}
            onChanged={reload}
            onError={setActionError}
            renderHob={(project) => <HobSummary project={project} />}
          />
        )}
        <p>
          <Link to="/deleted" className="text-sm text-muted underline underline-offset-4 hover:text-fg">
            Deleted hobs
          </Link>
        </p>
      </div>
    </div>
  )
}

function SearchBox({
  value,
  onChange,
  tags,
  onToggleTag,
}: {
  value: string
  onChange: (value: string) => void
  tags: { tag: string; hobs: number }[]
  onToggleTag: (tag: string) => void
}) {
  const terms = value.toLowerCase().split(/\s+/)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div>
      <label htmlFor="hob-search" className="sr-only">
        Search hobs
      </label>
      <input
        ref={input}
        id="hob-search"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search hobs"
        autoComplete="off"
        spellCheck={false}
        aria-describedby="hob-search-help"
        className="min-h-10 w-full rounded-md border border-border bg-surface-raised px-3 text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none"
      />
      <p id="hob-search-help" className="mt-2 text-sm text-muted">
        Search by name or tag, or narrow it down with <code className="font-mono">tag:kitchen</code>,{' '}
        <code className="font-mono">name:sleep-*</code> and <code className="font-mono">is:starred</code>. Put{' '}
        <code className="font-mono">-</code> in front to leave hobs out, as in <code className="font-mono">-tag:old</code>.
      </p>
      {tags.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Filter by tag">
          {tags.map(({ tag, hobs }) => {
            const active = terms.includes(`tag:${tag}`)
            return (
              <li key={tag}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    onToggleTag(tag)
                    input.current?.focus()
                  }}
                  className={`inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors ${
                    active
                      ? 'border-accent bg-accent/12 font-semibold text-fg'
                      : 'border-border text-muted hover:border-muted hover:text-fg'
                  }`}
                >
                  {tag}
                  <span className="text-xs tabular opacity-70">{hobs}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function HobSummary({ project }: { project: ProjectSummary }) {
  return (
    <Link
      to={`/projects/${encodeURIComponent(project.name)}`}
      className="group grid min-w-0 flex-1 gap-x-6 gap-y-1 py-5 sm:grid-cols-[1fr_auto] sm:items-center"
    >
      <div className="flex min-w-0 items-center gap-4">
        <ProjectIcon src={project.iconUrl} />
        <div className="min-w-0">
          <h3 className="text-[1.45rem] leading-snug font-semibold tracking-[-0.01em] group-hover:text-accent-fg">
            {project.name}
          </h3>
          <p className="mt-1 truncate text-muted">{project.currentVersion?.summary ?? 'No versions yet'}</p>
          {project.tags.length > 0 && (
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              {project.tags.map((tag) => (
                <span key={tag} className="rounded-full border border-border px-2 text-xs leading-5 text-muted">
                  {tag}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-1">
        <StatusBadge status={project.status} />
        {project.currentVersion && (
          <span className="text-sm text-muted tabular" title={exactTime(project.currentVersion.createdAt)}>
            Version {project.currentVersion.number}, {timeAgo(project.currentVersion.createdAt)}
          </span>
        )}
        {project.storage && <StorageLine storage={project.storage} />}
      </div>
    </Link>
  )
}

const PARTS: [keyof StorageUse, string][] = [
  ['database', 'Database'],
  ['files', 'Stored files'],
  ['branchDatabases', 'Branch database copies'],
  ['workspaces', 'Branch files'],
  ['repo', 'Code history'],
  ['builds', 'Builds'],
  ['logs', 'Logs'],
]

function StorageLine({ storage }: { storage: StorageUse }) {
  const breakdown = PARTS.map(([key, label]) => `${label}: ${bytes(storage[key] as number)}`).join('\n')
  return (
    <span className="text-sm text-muted tabular" title={breakdown}>
      {bytes(storage.total)} on disk, database {storage.database ? bytes(storage.database) : 'empty'}
      {storage.files ? `, files ${bytes(storage.files)}` : ''}
    </span>
  )
}
