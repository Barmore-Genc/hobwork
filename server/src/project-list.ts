import { publishChange } from './changes.ts'
import type { Host } from './host.ts'
import { ProjectError, requireProject, type Project } from './projects.ts'

export type ListedProject = Project & { starred: boolean; tags: string[] }

const TAG = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const MAX_TAG_LENGTH = 32
export const MAX_TAGS = 20

export function normalizeTag(tag: string): string {
  const normalized = tag.trim().toLowerCase()
  if (!TAG.test(normalized) || normalized.length > MAX_TAG_LENGTH) {
    throw new ProjectError(
      `Invalid tag "${tag}": use letters, digits and single hyphens, at most ${MAX_TAG_LENGTH} characters`,
    )
  }
  return normalized
}

// Starred hobs first, then each group in the order people put it in. Hobs
// never moved have no position and come last, by name.
const ORDER = 'starred DESC, position IS NULL, position, name'

function tagsByProject(host: Host): Map<number, string[]> {
  const tags = new Map<number, string[]>()
  for (const row of host.db.prepare('SELECT project_id, tag FROM project_tags ORDER BY tag').all()) {
    const id = Number(row.project_id)
    const list = tags.get(id) ?? []
    list.push(String(row.tag))
    tags.set(id, list)
  }
  return tags
}

// Hobs in list order, the ones matching `query` when given (see parseHobQuery).
export function listHobs(host: Host, query = ''): ListedProject[] {
  const matches = parseHobQuery(query)
  const tags = tagsByProject(host)
  return host.db
    .prepare(`SELECT id, name, default_branch, created_at, starred FROM projects ORDER BY ${ORDER}`)
    .all()
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      defaultBranch: String(row.default_branch),
      createdAt: String(row.created_at),
      starred: row.starred === 1,
      tags: tags.get(Number(row.id)) ?? [],
    }))
    .filter(matches)
}

export function hobTags(host: Host, projectId: number): string[] {
  return host.db
    .prepare('SELECT tag FROM project_tags WHERE project_id = ? ORDER BY tag')
    .all(projectId)
    .map((row) => String(row.tag))
}

export function isStarred(host: Host, projectId: number): boolean {
  return host.db.prepare('SELECT starred FROM projects WHERE id = ?').get(projectId)?.starred === 1
}

// Every tag in use, with how many hobs have it.
export function allTags(host: Host): { tag: string; hobs: number }[] {
  return host.db
    .prepare('SELECT tag, count(*) AS hobs FROM project_tags GROUP BY tag ORDER BY tag')
    .all()
    .map((row) => ({ tag: String(row.tag), hobs: Number(row.hobs) }))
}

function published(host: Host, name: string) {
  publishChange(host.db, { kind: 'projects' }, { kind: 'project', project: name })
}

// Puts a hob among the starred or the other hobs, before or after another hob
// of that group, or else at its end. The group is numbered again from 0.
export function moveHob(
  host: Host,
  name: string,
  { starred, before, after }: { starred: boolean; before?: string; after?: string },
): void {
  if (before !== undefined && after !== undefined) throw new ProjectError('Give before or after, not both')
  const project = requireProject(host, name)
  const { db } = host
  db.exec('BEGIN')
  try {
    const group = db
      .prepare(`SELECT id, name FROM projects WHERE starred = ? AND id != ? ORDER BY ${ORDER}`)
      .all(starred ? 1 : 0, project.id)
      .map((row) => ({ id: Number(row.id), name: String(row.name) }))
    let index = group.length
    const anchor = before ?? after
    if (anchor !== undefined) {
      const found = group.findIndex((p) => p.name === anchor)
      if (found === -1) {
        throw new ProjectError(`"${anchor}" is not one of the ${starred ? 'starred' : 'unstarred'} hobs`)
      }
      index = before !== undefined ? found : found + 1
    }
    group.splice(index, 0, { id: project.id, name })
    const update = db.prepare('UPDATE projects SET starred = ?, position = ? WHERE id = ?')
    group.forEach((p, position) => update.run(starred ? 1 : 0, position, p.id))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  published(host, name)
}

// A newly starred hob goes to the end of the starred ones. An unstarred one
// goes to the top of the others, right below where it was.
export function setStarred(host: Host, name: string, starred: boolean): void {
  const project = requireProject(host, name)
  if (isStarred(host, project.id) === starred) return
  const first = starred
    ? undefined
    : host.db.prepare(`SELECT name FROM projects WHERE starred = 0 ORDER BY ${ORDER} LIMIT 1`).get()?.name
  moveHob(host, name, { starred, before: first === undefined ? undefined : String(first) })
}

export function changeTags(
  host: Host,
  name: string,
  { add = [], remove = [] }: { add?: string[]; remove?: string[] },
): string[] {
  const project = requireProject(host, name)
  const added = add.map(normalizeTag)
  const removed = remove.map(normalizeTag)
  const { db } = host
  db.exec('BEGIN')
  try {
    const drop = db.prepare('DELETE FROM project_tags WHERE project_id = ? AND tag = ?')
    for (const tag of removed) drop.run(project.id, tag)
    const insert = db.prepare('INSERT OR IGNORE INTO project_tags (project_id, tag) VALUES (?, ?)')
    for (const tag of added) insert.run(project.id, tag)
    if (hobTags(host, project.id).length > MAX_TAGS) {
      throw new ProjectError(`A hob can have at most ${MAX_TAGS} tags`)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  if (added.length || removed.length) published(host, name)
  return hobTags(host, project.id)
}

export function setTags(host: Host, name: string, tags: string[]): string[] {
  const project = requireProject(host, name)
  const wanted = new Set(tags.map(normalizeTag))
  const current = hobTags(host, project.id)
  return changeTags(host, name, {
    add: [...wanted].filter((tag) => !current.includes(tag)),
    remove: current.filter((tag) => !wanted.has(tag)),
  })
}

export const QUERY_HELP =
  'Words match hob names and tags. name:<pattern> matches the name, with * and ? as wildcards. tag:<tag> matches a tag, also with wildcards. is:starred matches starred hobs. Put - in front of any term to exclude what it matches. All terms must match.'

function glob(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${source}$`)
}

function textMatcher(value: string): (text: string) => boolean {
  if (/[*?]/.test(value)) {
    const re = glob(value)
    return (text) => re.test(text)
  }
  return (text) => text.includes(value)
}

// Parses a hob search such as `lights tag:kitchen -is:starred name:sleep-*`
// into a test for hobs. Searches are case-insensitive.
export function parseHobQuery(query: string): (hob: ListedProject) => boolean {
  const tests: ((hob: ListedProject) => boolean)[] = []
  for (const raw of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const negate = raw.length > 1 && raw.startsWith('-')
    const term = negate ? raw.slice(1) : raw
    const colon = term.indexOf(':')
    let test: (hob: ListedProject) => boolean
    if (colon === -1) {
      test = (hob) => hob.name.includes(term) || hob.tags.some((tag) => tag.includes(term))
    } else {
      const key = term.slice(0, colon)
      const value = term.slice(colon + 1)
      if (!value) throw new ProjectError(`"${raw}" needs a value after the colon`)
      if (key === 'name') {
        const matches = textMatcher(value)
        test = (hob) => matches(hob.name)
      } else if (key === 'tag') {
        const re = glob(value)
        test = (hob) => hob.tags.some((tag) => re.test(tag))
      } else if (key === 'is') {
        if (value !== 'starred') throw new ProjectError(`Unknown filter "${raw}". is: only takes starred`)
        test = (hob) => hob.starred
      } else {
        throw new ProjectError(`Unknown filter "${raw}". Use name:, tag: or is:starred`)
      }
    }
    tests.push(negate ? (hob) => !test(hob) : test)
  }
  return (hob) => tests.every((test) => test(hob))
}
