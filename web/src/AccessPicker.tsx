import { useId } from 'react'
import { api, type Access } from './api.ts'
import { useLoad } from './useLoad.ts'

function Choice({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string
  checked: boolean
  onChange: () => void
  label: string
  hint: string
}) {
  return (
    <label className="flex cursor-pointer gap-3 py-1.5">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1.5 accent-accent" />
      <span>
        <span className="font-semibold">{label}</span>
        <span className="block text-sm text-muted">{hint}</span>
      </span>
    </label>
  )
}

export function AccessPicker({ access, onChange }: { access: Access; onChange: (access: Access) => void }) {
  const id = useId()
  const { data: projects } = useLoad(api.projects)
  const chosen = access.projects

  function toggle(project: string) {
    const current = chosen ?? []
    onChange({
      ...access,
      projects: current.includes(project) ? current.filter((p) => p !== project) : [...current, project].sort(),
    })
  }

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="font-semibold">What it can do</legend>
        <Choice
          name={`${id}-mode`}
          checked={!access.readOnly}
          onChange={() => onChange({ ...access, readOnly: false })}
          label="Build and change"
          hint="Change files, run commands in workspaces, merge changes to put them live, and run handlers."
        />
        <Choice
          name={`${id}-mode`}
          checked={access.readOnly}
          onChange={() => onChange({ ...access, readOnly: true })}
          label="Only read"
          hint="See files, logs, versions and Home Assistant. It cannot change anything or run handlers."
        />
      </fieldset>
      <fieldset>
        <legend className="font-semibold">Projects</legend>
        <Choice
          name={`${id}-projects`}
          checked={chosen === null}
          onChange={() => onChange({ ...access, projects: null })}
          label="All projects"
          hint="Including projects created later."
        />
        <Choice
          name={`${id}-projects`}
          checked={chosen !== null}
          onChange={() => onChange({ ...access, projects: chosen ?? [] })}
          label="Only some projects"
          hint="It cannot create projects."
        />
        {chosen !== null && (
          <div className="mt-1 ml-7">
            {projects?.length === 0 && <p className="text-sm text-muted">There are no projects yet.</p>}
            <ul className="space-y-1">
              {projects?.map((project) => (
                <li key={project.name}>
                  <label className="flex cursor-pointer items-center gap-3 py-1">
                    <input
                      type="checkbox"
                      checked={chosen.includes(project.name)}
                      onChange={() => toggle(project.name)}
                      className="accent-accent"
                    />
                    {project.name}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}
      </fieldset>
    </div>
  )
}
