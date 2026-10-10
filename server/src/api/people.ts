import type { IncomingMessage } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import { isTimeZone } from '../../../packages/sdk/src/time.ts'
import { HttpError, json, readJson } from '../http.ts'
import { hostTimeZone, reportTimeZone, setTimeZone, timeZoneSetting } from '../people.ts'
import type { ApiRoute } from './router.ts'

const TIME_ZONE_PATH = /^\/api\/me\/time-zone$/
const REPORT_PATH = /^\/api\/me\/time-zone\/report$/

async function timeZoneOf(req: IncomingMessage, allowNull: boolean): Promise<string | null> {
  const body = await readJson(req)
  const value = typeof body === 'object' && body !== null ? (body as { timeZone?: unknown }).timeZone : undefined
  if (value === null && allowNull) return null
  if (!isTimeZone(value)) throw new HttpError(400, `Send { "timeZone": "Europe/Istanbul" }${allowNull ? ' or { "timeZone": null } to follow your devices' : ''}`)
  return value
}

// The signed-in person's time zone. Handlers see it as Person.timeZone.
export function peopleRoutes(options: { db: DatabaseSync }): ApiRoute[] {
  const { db } = options
  const view = (userId: number) => ({ ...timeZoneSetting(db, userId), host: hostTimeZone() })
  return [
    { method: 'GET', pattern: TIME_ZONE_PATH, handle: ({ res, user }) => json(res, 200, view(user.id)) },
    {
      // null goes back to following what the person's browser and apps report.
      method: 'PUT',
      pattern: TIME_ZONE_PATH,
      handle: async ({ req, res, user }) => {
        setTimeZone(db, user.id, await timeZoneOf(req, true))
        json(res, 200, view(user.id))
      },
    },
    {
      // The web UI reports the browser's zone on load. Ignored once the person chose one.
      method: 'POST',
      pattern: REPORT_PATH,
      handle: async ({ req, res, user }) => {
        reportTimeZone(db, user.id, await timeZoneOf(req, false))
        json(res, 200, view(user.id))
      },
    },
  ]
}
