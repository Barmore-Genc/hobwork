import { expect, test } from 'vitest'
import { createLineSplitter } from './line-splitter.ts'
import { createLogLimiter } from './log-limiter.ts'

function collect(max: number) {
  const lines: string[] = []
  return { lines, push: createLineSplitter((line) => lines.push(line), max) }
}

test('splits lines across chunks', () => {
  const { lines, push } = collect(100)
  push('one\ntw')
  push('o\n\nthree')
  push('\n')
  expect(lines).toEqual(['one', 'two', '', 'three'])
})

test('cuts a line over the maximum and discards the rest of it', () => {
  const { lines, push } = collect(5)
  push('12345\n')
  push('1234567890')
  push('more and more')
  push('\nnext\n')
  expect(lines).toEqual(['12345', '12345 [line cut]', 'next'])
})

test('an endless line without a newline is emitted once', () => {
  const { lines, push } = collect(10)
  for (let i = 0; i < 1000; i++) push('x'.repeat(1000))
  expect(lines).toEqual([`${'x'.repeat(10)} [line cut]`])
})

test('the log limiter drops lines over the burst and reports them on the next kept line', () => {
  let time = 0
  const limiter = createLogLimiter({ burst: 3, perSecond: 1, now: () => time })
  expect([1, 2, 3].map(() => limiter.take())).toEqual(Array(3).fill({ keep: true, dropped: 0 }))
  expect(limiter.take()).toEqual({ keep: false, dropped: 0 })
  expect(limiter.take()).toEqual({ keep: false, dropped: 0 })
  time = 1000
  expect(limiter.take()).toEqual({ keep: true, dropped: 2 })
  expect(limiter.take()).toEqual({ keep: false, dropped: 0 })
})
