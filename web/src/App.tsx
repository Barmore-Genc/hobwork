import { useEffect, useState } from 'react'

type Project = { name: string; defaultBranch: string }

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null)

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then(setProjects)
      .catch(() => setProjects([]))
  }, [])

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Hobwork</h1>
      <h2 className="mt-6 text-lg font-medium">Projects</h2>
      {projects === null ? (
        <p className="text-neutral-500">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="text-neutral-500">No projects yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
          {projects.map((p) => (
            <li key={p.name} className="py-2">
              {p.name}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
