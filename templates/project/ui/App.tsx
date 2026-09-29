import { api } from '@hobwork/sdk/browser'
import { useEffect, useState } from 'react'

export default function App() {
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ message: string }>('greeting')
      .then((body) => setMessage(body.message))
      .catch(() => setError('Could not load the greeting'))
  }, [])

  return (
    <main className="mx-auto max-w-2xl p-6">
      <div className="rounded-lg border border-border bg-surface p-6">
        <h1 className="text-3xl font-semibold">{message ?? error ?? 'Loading…'}</h1>
        <p className="mt-2 text-muted">This page is the hob's dashboard.</p>
      </div>
    </main>
  )
}
