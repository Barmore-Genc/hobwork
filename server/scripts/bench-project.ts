import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Shaped like a Hobwork project: TSX modules using the platform set, and Vitest tests.
export function writeProject(dir: string) {
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bench', private: true, type: 'module' }))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      jsx: 'react-jsx',
      types: ['node'],
    },
    include: ['src', 'tests'],
  }))
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(dir, 'src', `mod${i}.tsx`), `
import { z } from 'zod'
import { addDays, format } from 'date-fns'
import { useState } from 'react'
${i > 0 ? `import { schema${i - 1} } from './mod${i - 1}.tsx'` : ''}

export const schema${i} = z.object({ id: z.number(), name: z.string(), when: z.string() })
export type Item${i} = z.infer<typeof schema${i}>

export function parse${i}(input: unknown): Item${i} {
  ${i > 0 ? `schema${i - 1}.safeParse(input)` : ''}
  return schema${i}.parse(input)
}

export function nextDay${i}(date: Date): string {
  return format(addDays(date, ${i}), 'yyyy-MM-dd')
}

export function Counter${i}() {
  const [n, setN] = useState(${i})
  return <button onClick={() => setN(n + 1)}>{n}</button>
}
`)
  }
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(dir, 'tests', `mod${i}.test.ts`), `
import { expect, test } from 'vitest'
import { nextDay${i}, parse${i} } from '../src/mod${i}.tsx'

test('parses', () => {
  expect(parse${i}({ id: 1, name: 'a', when: 'now' }).id).toBe(1)
  expect(() => parse${i}({})).toThrow()
})

test('adds days', () => {
  expect(nextDay${i}(new Date(2026, 0, 1))).toBe('2026-01-${String(1 + i).padStart(2, '0')}')
})
`)
  }
}
