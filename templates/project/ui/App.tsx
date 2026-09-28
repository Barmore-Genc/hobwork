import { useEffect, useState } from 'react'

export default function App() {
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    // Relative, because the dashboard is served under /p/<project>/ and routes under /p/<project>/api/.
    fetch('api/greeting')
      .then((res) => res.json())
      .then((body: { message: string }) => setMessage(body.message))
      .catch(() => setMessage('Could not load the greeting'))
  }, [])

  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">{message ?? 'Loading…'}</h1>
    </main>
  )
}
