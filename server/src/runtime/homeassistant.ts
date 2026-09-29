import { format } from 'node:util'
import type { Logger } from '../homeassistant/client.ts'
import type { Host } from '../host.ts'
import { getProject } from '../projects.ts'
import { appendLog, type LogLevel } from './logs.ts'

function record(host: Host, project: string, level: LogLevel, message: string) {
  if (!getProject(host, project)) return
  try {
    appendLog(host, { project, source: 'runtime', level, event: 'trigger', message })
  } catch (err) {
    console.error(`Could not record a trigger event for ${project}`, err)
  }
}

// The trigger registry names the project in its messages ('... of project "x"').
// They also go to the project's log so agents see refused and failed triggers.
export function triggerRegistryLogger(host: Host): Logger {
  const forward = (level: 'warn' | 'error', args: unknown[]) => {
    const message = format(...args)
    const project = /of project "([^"]+)"/.exec(message)?.[1]
    if (project) record(host, project, level, message)
  }
  return {
    info: (...args) => console.info(...args),
    warn(...args) {
      console.warn(...args)
      forward('warn', args)
    },
    error(...args) {
      console.error(...args)
      forward('error', args)
    },
  }
}

// Connection problems of the HA client affect every project with triggers:
// triggers that fire while the connection is down are lost.
export function homeAssistantClientLogger(host: Host, projectsWithTriggers: () => string[]): Logger {
  const forward = (level: 'warn' | 'error', args: unknown[]) => {
    const message = format(...args)
    if (!/trigger/i.test(message)) return
    for (const project of projectsWithTriggers()) record(host, project, level, message)
  }
  return {
    info: (...args) => console.info(...args),
    warn(...args) {
      console.warn(...args)
      forward('warn', args)
    },
    error(...args) {
      console.error(...args)
      forward('error', args)
    },
  }
}
