import { useEffect, useRef, useState } from 'react'
import { useLive, type LiveFilter } from './live.ts'

export type Page<T> = { items: T[]; more: boolean }

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// A newest-first list that loads older pages on demand. It loads from the
// start when `key` changes. When the host reports a change `live` accepts, the
// first page loads again and the older pages already shown stay.
export function usePaged<T>(options: {
  // Without `oldest`, the first page; with it, the page after that item.
  load: (oldest?: T) => Promise<Page<T>>
  key: string
  isOlder: (item: T, than: T) => boolean
  live?: LiveFilter
  onLoad?: () => void
}) {
  const { key } = options
  const [list, setList] = useState<(Page<T> & { key: string }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })
  useLive(options.live, () => setRefresh((n) => n + 1))

  useEffect(() => {
    let current = true
    latest.current.load().then(
      (page) => {
        if (!current) return
        setList((shown) => {
          const last = page.items.at(-1)
          const older = shown?.key === key && last ? shown.items.filter((item) => latest.current.isOlder(item, last)) : []
          return { key, items: [...page.items, ...older], more: older.length ? shown!.more : page.more }
        })
        setError(null)
        latest.current.onLoad?.()
      },
      (err: unknown) => {
        if (current) setError(message(err))
      },
    )
    return () => {
      current = false
    }
  }, [key, refresh])

  const shown = list?.key === key ? list : null

  async function loadMore() {
    const oldest = shown?.items.at(-1)
    if (!oldest) return
    setLoadingMore(true)
    try {
      const page = await latest.current.load(oldest)
      setList((current) => (current?.key === key ? { key, items: [...current.items, ...page.items], more: page.more } : current))
    } catch (err) {
      setError(message(err))
    } finally {
      setLoadingMore(false)
    }
  }

  return { items: shown?.items ?? null, more: shown?.more ?? false, error, loadingMore, loadMore }
}
