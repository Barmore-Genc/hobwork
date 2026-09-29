import { CronError, nextRun, parseCron, type Cron } from './cron.ts'

export type ScheduledCron = { name: string; schedule: string; next: Date | undefined }

export type Scheduler = {
  // Replaces the project's crons. Returns problems with individual schedules;
  // the valid ones are scheduled anyway.
  set(project: string, crons: Record<string, { schedule: string }>): string[]
  remove(project: string): void
  list(project: string): ScheduledCron[]
  stop(): void
}

type Job = { schedule: string; cron: Cron; next: Date | undefined; timer?: NodeJS.Timeout }

// setTimeout fires immediately for delays above this.
const MAX_DELAY_MS = 2 ** 31 - 1

// The host owns the schedule. Ticks missed while the host is down are not
// caught up.
export function createScheduler(fire: (project: string, cron: string) => void): Scheduler {
  const projects = new Map<string, Map<string, Job>>()

  function arm(project: string, name: string, job: Job) {
    clearTimeout(job.timer)
    if (!job.next) return
    const delay = job.next.getTime() - Date.now()
    job.timer = setTimeout(() => {
      if (!job.next) return
      // Timers can fire early, and long delays are split into several timers.
      if (Date.now() < job.next.getTime()) return arm(project, name, job)
      const due = job.next
      job.next = nextRun(job.cron, due)
      arm(project, name, job)
      fire(project, name)
    }, Math.min(Math.max(delay, 0), MAX_DELAY_MS))
    job.timer.unref()
  }

  function remove(project: string) {
    for (const job of projects.get(project)?.values() ?? []) clearTimeout(job.timer)
    projects.delete(project)
  }

  return {
    set(project, crons) {
      remove(project)
      const jobs = new Map<string, Job>()
      const problems: string[] = []
      const now = new Date()
      for (const [name, { schedule }] of Object.entries(crons)) {
        let cron: Cron
        try {
          cron = parseCron(schedule)
        } catch (err) {
          if (!(err instanceof CronError)) throw err
          problems.push(`cron "${name}": ${err.message}`)
          continue
        }
        const job: Job = { schedule, cron, next: nextRun(cron, now) }
        if (!job.next) problems.push(`cron "${name}": "${schedule}" never matches a date`)
        jobs.set(name, job)
        arm(project, name, job)
      }
      if (jobs.size) projects.set(project, jobs)
      return problems
    },
    remove,
    list(project) {
      return [...(projects.get(project) ?? [])].map(([name, job]) => ({ name, schedule: job.schedule, next: job.next }))
    },
    stop() {
      for (const project of projects.keys()) remove(project)
    },
  }
}
