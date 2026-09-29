import { useEffect, useState } from 'react'
import { api } from './api.ts'

const SEEN_KEY = 'hobwork:problems-seen-at'
const SEEN_EVENT = 'hobwork:problems-seen'
const DAY_MS = 24 * 60 * 60 * 1000
const REFRESH_MS = 60_000

// Problems count from when this browser last showed them, at most a week back.
function seenAt(): string {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(SEEN_KEY)
  } catch {}
  const oldest = Date.now() - 7 * DAY_MS
  const time = stored ? Date.parse(stored) : Date.now() - DAY_MS
  return new Date(Number.isNaN(time) ? Date.now() - DAY_MS : Math.max(time, oldest)).toISOString()
}

export function markProblemsSeen() {
  try {
    localStorage.setItem(SEEN_KEY, new Date().toISOString())
  } catch {}
  window.dispatchEvent(new Event(SEEN_EVENT))
}

// Problems across all projects the person has not looked at yet.
export function useAttention(pathname: string): { count: number; more: boolean } {
  const [state, setState] = useState({ count: 0, more: false })
  useEffect(() => {
    let current = true
    const load = () =>
      api.attention(seenAt()).then(
        (result) => current && setState(result),
        () => {},
      )
    void load()
    const timer = setInterval(load, REFRESH_MS)
    window.addEventListener(SEEN_EVENT, load)
    return () => {
      current = false
      clearInterval(timer)
      window.removeEventListener(SEEN_EVENT, load)
    }
  }, [pathname])
  return state
}
