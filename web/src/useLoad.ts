import { useEffect, useRef, useState } from 'react'

// Loads data when `key` changes or reload() is called. Results of a load that
// was superseded are dropped.
export function useLoad<T>(load: () => Promise<T>, key = '') {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })

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

  return { data, error, reload: () => setGeneration((g) => g + 1) }
}
