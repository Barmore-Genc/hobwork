import { afterEach, beforeEach, expect, test } from 'vitest'
import { createProject } from '../projects.ts'
import { queryLogs } from '../runtime/logs.ts'
import { createTestHost } from '../test-host.ts'
import { createPipelineLog } from './output-log.ts'

let host: ReturnType<typeof createTestHost>

beforeEach(async () => {
  host = createTestHost()
  await createProject(host, 'filament')
})

afterEach(() => host.dispose())

const messages = () => queryLogs(host, { project: 'filament', limit: 100 }).map((entry) => entry.message)

test('stores output line by line, including a last line without a newline', () => {
  const step = createPipelineLog(host, { project: 'filament', id: 3 }).step('lint')
  step.output('stdout', 'one\ntw')
  step.output('stdout', 'o\n\nthree')
  step.end()
  expect(messages()).toEqual(['run 3 lint: one', 'run 3 lint: two', 'run 3 lint: three'])
})

test('marks the cap once and drops the rest of the run', () => {
  const log = createPipelineLog(host, { project: 'filament', id: 1 }, { maxLines: 2 })
  log.step('test').output('stdout', 'a\nb\nc\nd\n')
  log.step('build').text('e')
  expect(messages()).toEqual([
    'run 1 test: a',
    'run 1 test: b',
    "run 1 test: [output limit reached, the rest of this run's output is in the run's step output]",
  ])
})
