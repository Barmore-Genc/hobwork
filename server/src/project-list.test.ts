import { afterEach, beforeEach, expect, test } from 'vitest'
import { onChange, type Change } from './changes.ts'
import { allTags, changeTags, listHobs, moveHob, parseHobQuery, setStarred, setTags, type ListedProject } from './project-list.ts'
import { createTestHost } from './test-host.ts'

let host: ReturnType<typeof createTestHost>

beforeEach(() => {
  host = createTestHost()
  for (const name of ['alarms', 'bins', 'coffee', 'doors', 'energy']) {
    host.db.prepare('INSERT INTO projects (name) VALUES (?)').run(name)
  }
})

afterEach(() => {
  host.dispose()
})

const names = (query?: string) => listHobs(host, query).map((p) => p.name)

test('hobs never moved are listed by name', () => {
  expect(names()).toEqual(['alarms', 'bins', 'coffee', 'doors', 'energy'])
})

test('starred hobs come first, newest star last', () => {
  setStarred(host, 'doors', true)
  setStarred(host, 'bins', true)
  expect(names()).toEqual(['doors', 'bins', 'alarms', 'coffee', 'energy'])
  expect(listHobs(host)[0]).toMatchObject({ name: 'doors', starred: true })
})

test('an unstarred hob goes to the top of the others', () => {
  moveHob(host, 'energy', { starred: false, before: 'alarms' })
  setStarred(host, 'coffee', true)
  setStarred(host, 'coffee', false)
  expect(names()).toEqual(['coffee', 'energy', 'alarms', 'bins', 'doors'])
})

test('moving puts a hob before or after another or at the end of its group', () => {
  moveHob(host, 'energy', { starred: false, before: 'bins' })
  expect(names()).toEqual(['alarms', 'energy', 'bins', 'coffee', 'doors'])
  moveHob(host, 'alarms', { starred: false, after: 'coffee' })
  expect(names()).toEqual(['energy', 'bins', 'coffee', 'alarms', 'doors'])
  moveHob(host, 'energy', { starred: false })
  expect(names()).toEqual(['bins', 'coffee', 'alarms', 'doors', 'energy'])
})

test('moving into the starred group stars a hob and out of it unstars it', () => {
  moveHob(host, 'coffee', { starred: true })
  moveHob(host, 'alarms', { starred: true, before: 'coffee' })
  expect(listHobs(host).filter((p) => p.starred).map((p) => p.name)).toEqual(['alarms', 'coffee'])
  moveHob(host, 'coffee', { starred: false, after: 'doors' })
  expect(names()).toEqual(['alarms', 'bins', 'doors', 'coffee', 'energy'])
  expect(listHobs(host).find((p) => p.name === 'coffee')?.starred).toBe(false)
})

test('a hob created after others were moved comes last', () => {
  moveHob(host, 'energy', { starred: false, before: 'alarms' })
  host.db.prepare('INSERT INTO projects (name) VALUES (?)').run('aquarium')
  expect(names()).toEqual(['energy', 'alarms', 'bins', 'coffee', 'doors', 'aquarium'])
})

test('moving next to a hob of the other group or an unknown hob is refused', () => {
  setStarred(host, 'bins', true)
  expect(() => moveHob(host, 'alarms', { starred: false, before: 'bins' })).toThrow('not one of the unstarred hobs')
  expect(() => moveHob(host, 'alarms', { starred: true, after: 'nope' })).toThrow('not one of the starred hobs')
  expect(() => moveHob(host, 'nope', { starred: true })).toThrow('does not exist')
  expect(() => moveHob(host, 'alarms', { starred: true, before: 'bins', after: 'bins' })).toThrow('not both')
  expect(names()).toEqual(['bins', 'alarms', 'coffee', 'doors', 'energy'])
})

test('tags are added, removed and replaced', () => {
  expect(changeTags(host, 'coffee', { add: ['Kitchen', ' morning '] })).toEqual(['kitchen', 'morning'])
  expect(changeTags(host, 'coffee', { add: ['kitchen'], remove: ['morning'] })).toEqual(['kitchen'])
  expect(setTags(host, 'bins', ['outside', 'kitchen'])).toEqual(['kitchen', 'outside'])
  expect(setTags(host, 'bins', ['outside'])).toEqual(['outside'])
  expect(allTags(host)).toEqual([
    { tag: 'kitchen', hobs: 1 },
    { tag: 'outside', hobs: 1 },
  ])
})

test('tags must be short kebab-case words and a hob has at most 20', () => {
  for (const bad of ['two words', 'a_b', '-a', '', 'x'.repeat(33)]) {
    expect(() => changeTags(host, 'coffee', { add: [bad] }), bad).toThrow('Invalid tag')
  }
  const many = Array.from({ length: 21 }, (_, i) => `t${i}`)
  expect(() => changeTags(host, 'coffee', { add: many })).toThrow('at most 20 tags')
  expect(listHobs(host).find((p) => p.name === 'coffee')?.tags).toEqual([])
})

test('stars, moves and tag changes are published', () => {
  const changes: Change[] = []
  onChange(host.db, (change) => changes.push(change))
  setStarred(host, 'bins', true)
  changeTags(host, 'bins', { add: ['outside'] })
  changeTags(host, 'bins', { add: [] })
  expect(changes).toEqual([
    { kind: 'projects' },
    { kind: 'project', project: 'bins' },
    { kind: 'projects' },
    { kind: 'project', project: 'bins' },
  ])
})

test('searching matches names, tags and stars', () => {
  setTags(host, 'coffee', ['kitchen', 'morning'])
  setTags(host, 'alarms', ['morning'])
  setTags(host, 'bins', ['outside'])
  setStarred(host, 'alarms', true)

  expect(names('off')).toEqual(['coffee'])
  expect(names('morn')).toEqual(['alarms', 'coffee'])
  expect(names('tag:morning')).toEqual(['alarms', 'coffee'])
  expect(names('tag:morn')).toEqual([])
  expect(names('tag:out*')).toEqual(['bins'])
  expect(names('TAG:Morning -is:starred')).toEqual(['coffee'])
  expect(names('is:starred')).toEqual(['alarms'])
  expect(names('name:*s')).toEqual(['alarms', 'bins', 'doors'])
  expect(names('name:d?ors')).toEqual(['doors'])
  expect(names('name:ne')).toEqual(['energy'])
  expect(names('-tag:morning -tag:outside')).toEqual(['doors', 'energy'])
  expect(names('  ')).toEqual(['alarms', 'bins', 'coffee', 'doors', 'energy'])
})

test('wildcards are the only special characters in patterns', () => {
  const hob = { name: 'a.b', tags: ['x+y'], starred: false } as ListedProject
  expect(parseHobQuery('name:a.b')(hob)).toBe(true)
  expect(parseHobQuery('name:a.*')(hob)).toBe(true)
  expect(parseHobQuery('name:a?b')(hob)).toBe(true)
  expect(parseHobQuery('tag:x+y')(hob)).toBe(true)
  expect(parseHobQuery('name:aab')({ ...hob, name: 'aab' })).toBe(true)
  expect(parseHobQuery('name:a.b')({ ...hob, name: 'aab' })).toBe(false)
})

test('unknown filters and filters without a value are refused', () => {
  expect(() => parseHobQuery('color:red')).toThrow('Unknown filter "color:red"')
  expect(() => parseHobQuery('is:broken')).toThrow('is: only takes starred')
  expect(() => parseHobQuery('tag:')).toThrow('needs a value')
})
