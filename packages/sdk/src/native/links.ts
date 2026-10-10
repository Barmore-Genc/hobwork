import { on } from './bridge.ts'

export type LinkOpened = {
  // The whole link, e.g. "https://filament.apps.example.com/spool/78".
  url: string
  // Path and query, e.g. "/spool/78".
  path: string
}

export const links = {
  // A link to this hob that opened the app (a universal link from a tag, a QR
  // code or another app) while a page of the hob listens. The app stays on
  // the page instead of loading the link, so the page decides what to show.
  onOpened: (listener: (link: LinkOpened) => void) => on<LinkOpened>('link.opened', listener),
}
