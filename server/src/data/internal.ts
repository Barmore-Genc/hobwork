import type { DbRequest, DbResponse } from '../../../packages/sdk/src/runner/protocol.ts'

// Answers POST http://hobwork.internal/v1/db with the executor's result: 200
// with rows, or 400 with the SQL error.
export async function dbResponse(body: string, execute: (request: DbRequest) => Promise<DbResponse>): Promise<Response> {
  let request: DbRequest
  try {
    request = JSON.parse(body) as DbRequest
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 })
  }
  if (typeof request !== 'object' || request === null) return Response.json({ error: 'Body must be an object' }, { status: 400 })
  const response = await execute(request)
  return Response.json(response, { status: response.ok ? 200 : 400 })
}
