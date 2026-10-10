import { expect, test } from 'vitest'
import { vector } from '../src/index.ts'
import { createTestDb } from '../src/testing.ts'

const migrations = new URL('./fixtures/migrations', import.meta.url).pathname

test('encode and decode round-trip float32 values in little-endian order', () => {
  const bytes = vector.encode([1, -2.5, 0.1])
  expect(bytes.byteLength).toBe(12)
  expect([...bytes.subarray(0, 4)]).toEqual([0, 0, 0x80, 0x3f])
  const decoded = vector.decode(bytes)
  expect(decoded.slice(0, 2)).toEqual([1, -2.5])
  expect(decoded[2]).toBeCloseTo(0.1, 6)
  expect(vector.decode(new Uint8Array(bytes.buffer.slice(4)))).toEqual([-2.5, Math.fround(0.1)])
  expect(() => vector.decode(new Uint8Array(3))).toThrow('float32')
})

test('SQL functions compare vectors in the hob DB', async () => {
  const db = createTestDb({ migrations })
  const a = vector.encode([1, 0])
  const b = vector.encode([0, 2])
  const c = vector.encode([3, 4])
  expect(
    await db.get('SELECT vec_dot(?, ?) AS dot, vec_distance_l2(?, ?) AS l2, vec_distance_cosine(?, ?) AS cosine', [c, c, a, c, a, b]),
  ).toEqual({ dot: 25, l2: Math.sqrt(4 + 16), cosine: 1 })
  expect(await db.get('SELECT vec_distance_cosine(?, ?) AS same, vec_distance_cosine(?, ?) AS zero, vec_dot(NULL, ?) AS missing', [a, a, a, vector.encode([0, 0]), a]))
    .toEqual({ same: 0, zero: null, missing: null })
  await expect(db.get('SELECT vec_dot(?, ?)', [a, vector.encode([1, 2, 3])])).rejects.toThrow('different lengths (2 and 3)')
  await expect(db.get('SELECT vec_dot(?, ?)', ['text', a])).rejects.toThrow('argument 1 must be a vector')
})

test('nearest rows by cosine distance', async () => {
  const db = createTestDb({ migrations })
  const rows = [['red', [1, 0, 0]], ['orange', [0.9, 0.4, 0]], ['blue', [0, 0, 1]]] as const
  for (const [color, embedding] of rows) {
    await db.run('INSERT INTO spools (color, label) VALUES (?, ?)', [color, vector.encode(embedding)])
  }
  const nearest = await db.query('SELECT color FROM spools ORDER BY vec_distance_cosine(label, ?) LIMIT 2', [vector.encode([1, 0.1, 0])])
  expect(nearest.map((row) => row.color)).toEqual(['red', 'orange'])
})
