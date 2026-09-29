// Guests get the host's time zone and locale so handlers and tests see the same
// dates and formats as the host, which also schedules crons in its time zone.
// The rest of the host's environment stays out of VMs.
export function systemEnv(
  env: NodeJS.ProcessEnv = process.env,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value && (name === 'LANG' || name === 'LANGUAGE' || name.startsWith('LC_'))) result[name] = value
  }
  // TZ is often unset, with the zone coming from /etc/localtime. Node resolves it either way.
  const tz = env.TZ || timeZone
  if (tz) result.TZ = tz
  return result
}
