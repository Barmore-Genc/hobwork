import { useId, useState } from 'react'
import { api } from '../../api.ts'
import { kindChanged } from '../../live.ts'
import { Link } from '../../router.tsx'
import { useLoad } from '../../useLoad.ts'

export function ProjectTags({ project, tags, onChanged }: { project: string; tags: string[]; onChanged: () => void }) {
  const id = useId()
  const { data: known } = useLoad(api.tags, '', kindChanged('projects'))
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(next: string[]) {
    setBusy(true)
    setError(null)
    try {
      await api.setProjectTags(project, next)
      onChanged()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function add() {
    const added = draft.split(/[\s,]+/).filter(Boolean)
    if (added.length === 0) return
    if (await save([...tags, ...added])) setDraft('')
  }

  const suggestions = (known ?? []).map((t) => t.tag).filter((tag) => !tags.includes(tag))
  return (
    <div className="mt-4">
      <ul className="flex flex-wrap items-center gap-2" aria-label="Tags">
        {tags.map((tag) => (
          <li key={tag} className="inline-flex min-h-8 items-center rounded-full border border-border text-sm">
            <Link to={`/?q=${encodeURIComponent(`tag:${tag}`)}`} className="pl-3 text-muted hover:text-fg">
              {tag}
            </Link>
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              disabled={busy}
              onClick={() => void save(tags.filter((t) => t !== tag))}
              className="flex size-8 items-center justify-center rounded-full text-muted hover:text-danger disabled:opacity-60"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </li>
        ))}
        <li>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void add()
            }}
          >
            <label htmlFor={id} className="sr-only">
              Add a tag
            </label>
            <input
              id={id}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
              list={`${id}-known`}
              placeholder={tags.length ? 'Add a tag' : 'Add tags, such as kitchen'}
              autoComplete="off"
              spellCheck={false}
              className="min-h-8 w-44 rounded-full border border-dashed border-border bg-transparent px-3 text-sm text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none"
            />
            <datalist id={`${id}-known`}>
              {suggestions.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
          </form>
        </li>
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
