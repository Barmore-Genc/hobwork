import { isTimeZone } from '../../../packages/sdk/src/time.ts'
import { CronError, nextRun, parseCron, type Cron } from './cron.ts'

// The time zone a cron runs in: an IANA name, or "person" for one run per
// person in their own zone. Without one, the host's.
export type CronEntry = { schedule: string; timeZone?: string }

export const PERSON_TIME_ZONE = 'person'

export type ScheduledCron = { name: string; schedule: string; timeZone?: string; next: Date | undefined }

export type SchedulePerson = { id: number; timeZone: string }

export type Scheduler = {
  // Replaces the project's crons. Returns problems with individual schedules;
  // the valid ones are scheduled anyway.
  set(project: string, crons: Record<string, CronEntry>): string[]
  remove(project: string): void
  list(project: string): ScheduledCron[]
  // People or their time zones changed: reschedules per-person crons.
  refreshPeople(): void
  stop(): void
}

// One timer: the cron, or the cron for one person.
type Run = { timeZone?: string; person?: number; next: Date | undefined; timer?: NodeJS.Timeout }

type Job = { schedule: string; timeZone?: string; cron: Cron; runs: Run[] }

// setTimeout fires immediately for delays above this.
const MAX_DELAY_MS = 2 ** 31 - 1

// The host owns the schedule. Ticks missed while the host is down are not
// caught up.
export function createScheduler(
  fire: (project: string, cron: string, person?: number) => void,
  options: { people?: () => SchedulePerson[] } = {},
): Scheduler {
  const projects = new Map<string, Map<string, Job>>()
  const entries = new Map<string, Record<string, CronEntry>>()

  function arm(project: string, name: string, job: Job, run: Run) {
    clearTimeout(run.timer)
    if (!run.next) return
    const delay = run.next.getTime() - Date.now()
    run.timer = setTimeout(() => {
      if (!run.next) return
      // Timers can fire early, and long delays are split into several timers.
      if (Date.now() < run.next.getTime()) return arm(project, name, job, run)
      const due = run.next
      run.next = nextRun(job.cron, due, run.timeZone)
      arm(project, name, job, run)
      fire(project, name, run.person)
    }, Math.min(Math.max(delay, 0), MAX_DELAY_MS))
    run.timer.unref()
  }

  function remove(project: string) {
    for (const job of projects.get(project)?.values() ?? []) {
      for (const run of job.runs) clearTimeout(run.timer)
    }
    projects.delete(project)
    entries.delete(project)
  }

  function set(project: string, crons: Record<string, CronEntry>): string[] {
    remove(project)
    const jobs = new Map<string, Job>()
    const problems: string[] = []
    const now = new Date()
    for (const [name, { schedule, timeZone }] of Object.entries(crons)) {
      let cron: Cron
      try {
        cron = parseCron(schedule)
      } catch (err) {
        if (!(err instanceof CronError)) throw err
        problems.push(`cron "${name}": ${err.message}`)
        continue
      }
      if (timeZone !== undefined && timeZone !== PERSON_TIME_ZONE && !isTimeZone(timeZone)) {
        problems.push(`cron "${name}": "${timeZone}" is not a known time zone`)
        continue
      }
      const runs: Run[] =
        timeZone === PERSON_TIME_ZONE
          ? (options.people?.() ?? []).map((person) => ({ timeZone: person.timeZone, person: person.id, next: undefined }))
          : [{ timeZone, next: undefined }]
      const job: Job = { schedule, ...(timeZone !== undefined ? { timeZone } : {}), cron, runs }
      // In the host's zone: any zone's version of an impossible date is impossible too.
      if (!nextRun(cron, now)) problems.push(`cron "${name}": "${schedule}" never matches a date`)
      for (const run of runs) {
        run.next = nextRun(cron, now, run.timeZone)
        arm(project, name, job, run)
      }
      jobs.set(name, job)
    }
    if (jobs.size) projects.set(project, jobs)
    entries.set(project, crons)
    return problems
  }

  return {
    set,
    remove,
    list(project) {
      return [...(projects.get(project) ?? [])].map(([name, job]) => {
        const next = job.runs
          .map((run) => run.next)
          .filter((date) => date !== undefined)
          .sort((a, b) => a.getTime() - b.getTime())[0]
        return { name, schedule: job.schedule, ...(job.timeZone !== undefined ? { timeZone: job.timeZone } : {}), next }
      })
    },
    refreshPeople() {
      // set() deletes and adds the entry again, which a live iteration would visit twice.
      for (const [project, crons] of Array.from(entries)) {
        if (Object.values(crons).some((entry) => entry.timeZone === PERSON_TIME_ZONE)) set(project, crons)
      }
    },
    stop() {
      for (const project of projects.keys()) remove(project)
    },
  }
}
