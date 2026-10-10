import type { DatabaseSync } from 'node:sqlite'

// Vectors are BLOBs of little-endian float32 values, as `vector.encode` in
// @hobwork/sdk writes them.
function floats(value: unknown, name: string, argument: number): DataView | null {
  if (value === null) return null
  if (!(value instanceof Uint8Array) || value.byteLength % 4 !== 0) {
    throw new Error(`${name}: argument ${argument} must be a vector, a BLOB of float32 values (vector.encode in @hobwork/sdk)`)
  }
  return new DataView(value.buffer, value.byteOffset, value.byteLength)
}

function pair(name: string, a: unknown, b: unknown): [DataView, DataView] | null {
  const x = floats(a, name, 1)
  const y = floats(b, name, 2)
  if (!x || !y) return null
  if (x.byteLength !== y.byteLength) {
    throw new Error(`${name}: the vectors have different lengths (${x.byteLength / 4} and ${y.byteLength / 4})`)
  }
  return [x, y]
}

function dot(x: DataView, y: DataView): number {
  let sum = 0
  for (let i = 0; i < x.byteLength; i += 4) sum += x.getFloat32(i, true) * y.getFloat32(i, true)
  return sum
}

// Brute force over every row is fast enough for hob-sized tables, so there is
// no index and no native extension.
export function registerVectorFunctions(db: DatabaseSync) {
  // directOnly: views, triggers, CHECK constraints and indexes cannot use them,
  // so the DB file still opens where they are not registered.
  const options = { deterministic: true, directOnly: true }
  db.function('vec_dot', options, (a, b) => {
    const vectors = pair('vec_dot', a, b)
    return vectors && dot(...vectors)
  })
  db.function('vec_distance_l2', options, (a, b) => {
    const vectors = pair('vec_distance_l2', a, b)
    if (!vectors) return null
    const [x, y] = vectors
    let sum = 0
    for (let i = 0; i < x.byteLength; i += 4) {
      const d = x.getFloat32(i, true) - y.getFloat32(i, true)
      sum += d * d
    }
    return Math.sqrt(sum)
  })
  db.function('vec_distance_cosine', options, (a, b) => {
    const vectors = pair('vec_distance_cosine', a, b)
    if (!vectors) return null
    const [x, y] = vectors
    const norms = Math.sqrt(dot(x, x) * dot(y, y))
    // A zero vector has no direction.
    return norms === 0 ? null : 1 - dot(x, y) / norms
  })
}
