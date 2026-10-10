import { call } from './bridge.ts'

export type ClipboardContents = {
  text: string | null
  // Set when the clipboard holds a link.
  url: string | null
}

// The system clipboard. Reading asks the person once per hob, and on iOS the
// system also shows its own "Allow Paste" prompt, so read in response to a tap.
// In a browser, use navigator.clipboard instead.
export const clipboard = {
  read: () => call<ClipboardContents>('clipboard', 'read'),
  writeText: (text: string) => call<void>('clipboard', 'write', { text }),
}
