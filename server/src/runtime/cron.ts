// Standard 5-field cron (minute hour day-of-month month day-of-week) in the
// host's local time zone. Fields take `*`, numbers, ranges (`1-5`), lists
// (`1,15`), steps (`*/10`, `8-18/2`) and English month and weekday names
// (`jan`, `mon-fri`). Day-of-week 0 and 7 are Sunday. As in Vixie cron, when
// both day fields are restricted a day matches if either one does.

export class CronError extends Error {}

export type Cron = {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  // True when the field is `*` (or `*/1`), for the day-of-month/day-of-week rule.
  anyDayOfMonth: boolean
  anyDayOfWeek: boolean
}

type Field = { name: string; min: number; max: number; names?: string[] }

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const FIELDS: Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day of week', min: 0, max: 7, names: DAY_NAMES },
]

// Far enough to find the next run of any valid expression (Feb 29 on a given
// weekday can take 28 years), short enough to give up on impossible ones like `0 0 31 2 *`.
const SEARCH_YEARS = 30

function parseValue(text: string, field: Field): number {
  const index = field.names?.indexOf(text.toLowerCase()) ?? -1
  if (index >= 0) return index + (field.name === 'month' ? 1 : 0)
  if (!/^\d+$/.test(text)) throw new CronError(`"${text}" is not a valid ${field.name}`)
  const value = Number(text)
  if (value < field.min || value > field.max) {
    throw new CronError(`${field.name} ${value} is out of range (${field.min}-${field.max})`)
  }
  return value
}

function parseField(text: string, field: Field): { values: Set<number>; any: boolean } {
  const values = new Set<number>()
  let any = false
  for (const part of text.split(',')) {
    const [range = '', stepText, ...rest] = part.split('/')
    if (rest.length) throw new CronError(`"${part}" is not a valid ${field.name}`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1 || !/^\d+$/.test(stepText ?? '1')) {
      throw new CronError(`"${stepText}" is not a valid step in the ${field.name} field`)
    }
    let from: number
    let to: number
    if (range === '*') {
      from = field.min
      to = field.max
      if (step === 1) any = true
    } else {
      const [start = '', end, ...more] = range.split('-')
      if (more.length) throw new CronError(`"${range}" is not a valid ${field.name} range`)
      from = parseValue(start, field)
      to = end === undefined ? (stepText === undefined ? from : field.max) : parseValue(end, field)
      if (to < from) throw new CronError(`${field.name} range ${range} goes backwards`)
    }
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return { values, any }
}

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronError(`"${expression}" must have 5 fields (minute hour day-of-month month day-of-week)`)
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parts.map((part, i) => parseField(part, FIELDS[i]!))
  const dow = daysOfWeek!.values
  if (dow.has(7)) {
    dow.delete(7)
    dow.add(0)
  }
  return {
    minutes: minutes!.values,
    hours: hours!.values,
    daysOfMonth: daysOfMonth!.values,
    months: months!.values,
    daysOfWeek: dow,
    anyDayOfMonth: daysOfMonth!.any,
    anyDayOfWeek: daysOfWeek!.any,
  }
}

function dayMatches(cron: Cron, date: Date): boolean {
  const dom = cron.daysOfMonth.has(date.getDate())
  const dow = cron.daysOfWeek.has(date.getDay())
  if (cron.anyDayOfMonth || cron.anyDayOfWeek) return dom && dow
  return dom || dow
}

// The first run strictly after `after`, or undefined if the expression never
// matches. Runs are wall-clock times: a time skipped by a DST change does not
// run, and a time that happens twice runs once.
export function nextRun(cron: Cron, after: Date): Date | undefined {
  const start = new Date(after.getFullYear(), after.getMonth(), after.getDate())
  const minutes = [...cron.minutes].sort((a, b) => a - b)
  const hours = [...cron.hours].sort((a, b) => a - b)
  const afterWall = [after.getFullYear(), after.getMonth(), after.getDate(), after.getHours(), after.getMinutes()]
  for (let offset = 0; offset < SEARCH_YEARS * 366; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset)
    if (!cron.months.has(day.getMonth() + 1) || !dayMatches(cron, day)) continue
    const sameDay = offset === 0
    for (const hour of hours) {
      if (sameDay && hour < afterWall[3]!) continue
      for (const minute of minutes) {
        if (sameDay && hour === afterWall[3] && minute <= afterWall[4]!) continue
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute)
        // A wall time inside a DST gap does not exist and gets shifted.
        if (candidate.getHours() !== hour || candidate.getMinutes() !== minute) continue
        return candidate
      }
    }
  }
  return undefined
}
