import { useEffect, useRef, useState } from 'react'
import { useLive, type LiveFilter } from './live.ts'

// Loads data when `key` changes, reload() is called or the host reports a
// change `live` accepts. Results of a load that was superseded are dropped.
export function useLoad<T>(load: () => Promise<T>, key = '', live?: LiveFilter) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  const reload = () => setGeneration((g) => g + 1)
  useLive(live, reload)

  useEffect(() => {
    let current = true
    loadRef.current().then(
      (value) => {
        if (!current) return
        setData(value)
        setError(null)
      },
      (err: unknown) => {
        if (current) setError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      current = false
    }
  }, [key, generation])

  return { data, error, reload }
}
