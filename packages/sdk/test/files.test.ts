import { expect, test } from 'vitest'
import { FilesError } from '../src/index.ts'
import { createTestContext, createTestFiles } from '../src/testing.ts'

test('test files follow the host rules', async () => {
  const files = createTestFiles()
  expect(await files.put('photos/cat.jpg', new Uint8Array([1, 2]))).toMatchObject({ path: 'photos/cat.jpg', size: 2 })
  await files.put('notes.txt', 'héllo')
  await files.put('a/b.txt', new Blob(['b']))
  expect(await (await files.get('notes.txt'))!.text()).toBe('héllo')
  expect(Array.from(await (await files.get('photos/cat.jpg'))!.bytes())).toEqual([1, 2])
  expect(await files.get('missing')).toBeUndefined()
  expect(await files.stat('notes.txt')).toMatchObject({ size: 6 })
  expect((await files.list()).map((f) => f.path)).toEqual(['a/b.txt', 'notes.txt', 'photos/cat.jpg'])
  expect((await files.list({ prefix: 'photos/' })).map((f) => f.path)).toEqual(['photos/cat.jpg'])
  expect((await files.list({ after: 'a/b.txt', limit: 1 })).map((f) => f.path)).toEqual(['notes.txt'])

  await expect(files.put('../x', 'x')).rejects.toBeInstanceOf(FilesError)
  await expect(files.put('photos/cat.jpg/x', 'x')).rejects.toMatchObject({ code: 'conflict' })
  await expect(files.put('photos', 'x')).rejects.toMatchObject({ code: 'conflict' })
  expect(await files.delete('notes.txt')).toBe(true)
  expect(await files.delete('notes.txt')).toBe(false)
})

test('test contexts get their own empty files', async () => {
  const one = createTestContext()
  await one.files.put('a.txt', 'a')
  expect(await createTestContext().files.list()).toEqual([])
})
