import { ProjectLayout } from './ProjectLayout.tsx'

export function ProjectAppPage({ name }: { name: string }) {
  const src = `/p/${encodeURIComponent(name)}/`
  return (
    <ProjectLayout name={name} tab="app">
      {(project) =>
        project.app ? (
          <div className="mt-6">
            <div className="mb-2 flex justify-end">
              <a href={src} target="_blank" rel="noopener" className="text-sm text-muted underline decoration-border underline-offset-4 hover:text-fg">
                Open in a new tab
              </a>
            </div>
            <iframe
              src={src}
              title={`${name} app`}
              className="block h-[calc(100dvh-17rem)] min-h-[28rem] w-full rounded-lg border border-border bg-bg"
            />
          </div>
        ) : (
          <p className="mt-8 text-muted">{name} has no app to open.</p>
        )
      }
    </ProjectLayout>
  )
}
