import type { AppLinks } from '../runtime/config.ts'
import type { StaticMount } from '../runtime/files.ts'

// Universal links to hob pages: `https://<hob>.<apps host>/spool/78` opens the
// Hobwork app when it is installed (built with `applinks:*.<apps host>`).

export const AASA_PATH = '/.well-known/apple-app-site-association'

// Never pages: routes, the host's own paths on the app origin (the sign-in
// callback must stay in the browser), the theme and well-known files.
export const RESERVED_LINK_PATHS = ['/api/*', '/_hobwork/*', '/theme/*', '/.well-known/*']

export type LinkRules = { include: string[]; exclude: string[] }

// What opens the app for one hob: its include list (default every path)
// minus the reserved paths, its static directories and its exclude list.
export function linkRules(appLinks: AppLinks | undefined, mounts: StaticMount[]): LinkRules {
  const statics = mounts.flatMap((mount) => [mount.prefix, `${mount.prefix}/*`])
  return {
    include: appLinks?.include ?? ['/*'],
    exclude: [...RESERVED_LINK_PATHS, ...statics, ...(appLinks?.exclude ?? [])],
  }
}

// The first component that matches decides, so exclusions come first.
export function aasaFile(appleAppId: string, rules: LinkRules) {
  return {
    applinks: {
      details: [
        {
          appIDs: [appleAppId],
          components: [
            ...rules.exclude.map((path) => ({ '/': path, exclude: true })),
            ...rules.include.map((path) => ({ '/': path })),
          ],
        },
      ],
    },
  }
}
