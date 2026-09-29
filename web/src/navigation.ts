import { useEffect, useState } from 'react'

const listeners = new Set<() => void>()

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (options.replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  window.scrollTo(0, 0)
  for (const listener of listeners) listener()
}

export function useLocation(): { pathname: string; search: URLSearchParams } {
  const [location, setLocation] = useState(() => window.location.href)
  useEffect(() => {
    const update = () => setLocation(window.location.href)
    listeners.add(update)
    window.addEventListener('popstate', update)
    return () => {
      listeners.delete(update)
      window.removeEventListener('popstate', update)
    }
  }, [])
  const url = new URL(location)
  return { pathname: url.pathname, search: url.searchParams }
}
