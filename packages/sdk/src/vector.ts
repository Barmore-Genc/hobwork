// Vectors (like embeddings from openrouter(ctx).embed()) are stored in the hob
// DB as BLOBs of little-endian float32 values, which vec_distance_cosine,
// vec_distance_l2 and vec_dot compare in SQL.
export const vector = {
  encode(values: ArrayLike<number>): Uint8Array {
    const bytes = new Uint8Array(values.length * 4)
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i]!, true)
    return bytes
  },
  decode(bytes: Uint8Array): number[] {
    if (bytes.byteLength % 4 !== 0) throw new Error('A vector is a whole number of float32 values, 4 bytes each')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const values: number[] = []
    for (let i = 0; i < bytes.byteLength; i += 4) values.push(view.getFloat32(i, true))
    return values
  },
}
