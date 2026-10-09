import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type ProjectSummary } from '../api.ts'
import { StarIcon } from '../ui.tsx'

// Where a hob goes: the starred or the other hobs, and its index among them
// without the hob itself.
type Place = { starred: boolean; index: number }

type Drag = { name: string; startY: number; clientY: number; target: Place }

// Pixels from the window edge where dragging scrolls the page.
const SCROLL_EDGE = 80
const SCROLL_STEP = 12

// Hob rows split into starred and other hobs. Rows move by dragging their
// handle with a mouse, pen or finger, or with the arrow keys; moving one into
// or out of the starred hobs stars or unstars it.
export function HobList({
  projects,
  searching,
  onChanged,
  onError,
  renderHob,
}: {
  projects: ProjectSummary[]
  searching: boolean
  onChanged: () => void
  onError: (message: string | null) => void
  renderHob: (project: ProjectSummary) => ReactNode
}) {
  // Shows a move or star right away, until the list loads again.
  const [pending, setPendingState] = useState<{ base: ProjectSummary[]; list: ProjectSummary[] } | null>(null)
  const list = pending?.base === projects ? pending.list : projects
  const setPending = (next: ProjectSummary[] | null) => setPendingState(next && { base: projects, list: next })
  const starred = list.filter((p) => p.starred)
  const others = list.filter((p) => !p.starred)
  const showStarred = starred.length > 0 || !searching

  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const lists = useRef<Record<'starred' | 'others', HTMLUListElement | null>>({ starred: null, others: null })
  const [announcement, setAnnouncement] = useState('')
  const focusHandle = useRef<string | null>(null)

  useEffect(() => {
    const name = focusHandle.current
    if (!name) return
    focusHandle.current = null
    document.querySelector<HTMLElement>(`[data-handle="${CSS.escape(name)}"]`)?.focus()
  }, [list])

  function updateDrag(next: Drag | null) {
    dragRef.current = next
    setDrag(next)
  }

  function targetAt(y: number, name: string): Place {
    const sections = (
      [
        { starred: true, el: lists.current.starred },
        { starred: false, el: lists.current.others },
      ] as const
    ).filter((s) => s.el !== null)
    let section = sections[sections.length - 1]!
    if (sections.length === 2) {
      const above = sections[0]!.el!.getBoundingClientRect()
      const below = sections[1]!.el!.getBoundingClientRect()
      section = y < (above.bottom + below.top) / 2 ? sections[0]! : sections[1]!
    }
    let index = 0
    for (const row of section.el!.querySelectorAll<HTMLElement>(':scope > li[data-hob]')) {
      if (row.dataset.hob === name) continue
      const rect = row.getBoundingClientRect()
      if (y > rect.top + rect.height / 2) index++
    }
    return { starred: section.starred, index }
  }

  function dragTo(clientY: number) {
    const current = dragRef.current
    if (!current) return
    updateDrag({ ...current, clientY, target: targetAt(clientY, current.name) })
  }

  const dragging = drag !== null
  useEffect(() => {
    if (!dragging) return
    let frame = requestAnimationFrame(function scroll() {
      const current = dragRef.current
      if (current) {
        const step =
          current.clientY < SCROLL_EDGE ? -SCROLL_STEP : current.clientY > window.innerHeight - SCROLL_EDGE ? SCROLL_STEP : 0
        if (step) {
          window.scrollBy(0, step)
          dragTo(current.clientY)
        }
      }
      frame = requestAnimationFrame(scroll)
    })
    return () => cancelAnimationFrame(frame)
  })

  function move(name: string, place: Place) {
    const hob = list.find((p) => p.name === name)
    if (!hob) return
    const group = list.filter((p) => p.starred === place.starred && p.name !== name)
    const to =
      place.index < group.length
        ? { starred: place.starred, before: group[place.index]!.name }
        : group.length > 0
          ? { starred: place.starred, after: group[group.length - 1]!.name }
          : { starred: place.starred }
    group.splice(place.index, 0, { ...hob, starred: place.starred })
    const rest = list.filter((p) => p.starred !== place.starred && p.name !== name)
    const next = place.starred ? [...group, ...rest] : [...rest, ...group]
    if (next.every((p, i) => p.name === list[i]!.name && p.starred === list[i]!.starred)) return

    setPending(next)
    setAnnouncement(
      `${name} moved to position ${place.index + 1} of ${group.length} in ${place.starred ? 'starred hobs' : 'other hobs'}`,
    )
    onError(null)
    api.moveProject(name, to).then(onChanged, (err: unknown) => {
      setPending(null)
      onError(err instanceof Error ? err.message : String(err))
    })
  }

  function moveByKey(name: string, step: -1 | 1) {
    const hob = list.find((p) => p.name === name)
    if (!hob) return
    const group = hob.starred ? starred : others
    const index = group.indexOf(hob) + step
    focusHandle.current = name
    if (index >= 0 && index < group.length) move(name, { starred: hob.starred, index })
    else if (step < 0 && !hob.starred && showStarred) move(name, { starred: true, index: starred.length })
    else if (step > 0 && hob.starred) move(name, { starred: false, index: 0 })
  }

  function toggleStar(hob: ProjectSummary) {
    const starring = !hob.starred
    const rest = list.filter((p) => p.name !== hob.name)
    const moved = { ...hob, starred: starring }
    const lastStarred = rest.filter((p) => p.starred).length
    setPending([...rest.slice(0, lastStarred), moved, ...rest.slice(lastStarred)])
    onError(null)
    api.starProject(hob.name, starring).then(onChanged, (err: unknown) => {
      setPending(null)
      onError(err instanceof Error ? err.message : String(err))
    })
  }

  // The row the drop line shows above, or below for the end of a group.
  function dropLine(group: ProjectSummary[], starredGroup: boolean, name: string): 'above' | 'below' | null {
    if (!drag || drag.target.starred !== starredGroup) return null
    const without = group.filter((p) => p.name !== drag.name)
    if (drag.target.index < without.length) return without[drag.target.index]!.name === name ? 'above' : null
    return without[without.length - 1]?.name === name ? 'below' : null
  }

  function row(hob: ProjectSummary, group: ProjectSummary[]) {
    const isDragged = drag?.name === hob.name
    const line = dropLine(group, hob.starred, hob.name)
    return (
      <li
        key={hob.name}
        data-hob={hob.name}
        className={`relative flex items-center gap-1 ${isDragged ? 'z-10 rounded-md bg-surface-raised shadow-[0_12px_32px_-12px_rgb(0_0_0/0.45)]' : ''}`}
        style={isDragged ? { transform: `translateY(${drag.clientY + window.scrollY - drag.startY}px)` } : undefined}
      >
        {line && (
          <span
            aria-hidden="true"
            className={`absolute inset-x-0 h-0.5 rounded-full bg-accent ${line === 'above' ? '-top-px' : '-bottom-px'}`}
          />
        )}
        <button
          type="button"
          data-handle={hob.name}
          aria-label={`Move ${hob.name}`}
          aria-describedby="hob-move-help"
          className="-ml-2 flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted select-none hover:bg-surface hover:text-fg active:cursor-grabbing"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            updateDrag({
              name: hob.name,
              startY: e.clientY + window.scrollY,
              clientY: e.clientY,
              target: targetAt(e.clientY, hob.name),
            })
          }}
          onPointerMove={(e) => {
            if (dragRef.current?.name === hob.name) dragTo(e.clientY)
          }}
          onPointerUp={() => {
            const current = dragRef.current
            updateDrag(null)
            if (current) move(current.name, current.target)
          }}
          onPointerCancel={() => updateDrag(null)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
            e.preventDefault()
            moveByKey(hob.name, e.key === 'ArrowUp' ? -1 : 1)
          }}
        >
          <GripIcon />
        </button>
        {renderHob(hob)}
        <button
          type="button"
          aria-pressed={hob.starred}
          aria-label={`Star ${hob.name}`}
          title={hob.starred ? 'Starred' : 'Star'}
          onClick={() => toggleStar(hob)}
          className={`flex size-10 shrink-0 items-center justify-center rounded-md hover:bg-surface ${
            hob.starred ? 'text-accent-fg' : 'text-muted hover:text-fg'
          }`}
        >
          <StarIcon filled={hob.starred} />
        </button>
      </li>
    )
  }

  const listClass = 'divide-y divide-border border-y border-border'
  return (
    <div className="space-y-8">
      <p id="hob-move-help" className="sr-only">
        Drag to move, or press the up and down arrow keys. Moving a hob into the starred hobs stars it.
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {showStarred && (
        <section aria-labelledby="starred-hobs">
          <h2 id="starred-hobs" className="mb-2 text-sm font-semibold text-muted">
            Starred
          </h2>
          {starred.length > 0 ? (
            <ul ref={(el) => void (lists.current.starred = el)} className={listClass}>
              {starred.map((hob) => row(hob, starred))}
            </ul>
          ) : (
            <ul
              ref={(el) => void (lists.current.starred = el)}
              className={`rounded-lg border border-dashed px-4 py-4 text-sm transition-colors ${
                drag?.target.starred === true ? 'border-accent bg-accent/8 text-fg' : 'border-border text-muted'
              }`}
            >
              <li>Star a hob or drag it here to keep it at the top.</li>
            </ul>
          )}
        </section>
      )}
      {(others.length > 0 || showStarred) && (
        <section aria-labelledby={showStarred ? 'other-hobs' : undefined}>
          {showStarred && (
            <h2 id="other-hobs" className="mb-2 text-sm font-semibold text-muted">
              {starred.length > 0 ? 'Other hobs' : 'All hobs'}
            </h2>
          )}
          {others.length > 0 ? (
            <ul ref={(el) => void (lists.current.others = el)} className={listClass}>
              {others.map((hob) => row(hob, others))}
            </ul>
          ) : (
            <ul
              ref={(el) => void (lists.current.others = el)}
              className={`rounded-lg border border-dashed px-4 py-4 text-sm transition-colors ${
                drag?.target.starred === false ? 'border-accent bg-accent/8 text-fg' : 'border-border text-muted'
              }`}
            >
              <li>Drag a starred hob here to unstar it.</li>
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function GripIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-5" fill="currentColor" aria-hidden="true">
      {[6, 10, 14].flatMap((y) => [7, 13].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" />))}
    </svg>
  )
}
