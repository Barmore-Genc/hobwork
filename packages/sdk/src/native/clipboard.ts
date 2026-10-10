import { call } from './bridge.ts'

export type ClipboardContents = {
  text: string | null
  // Set when the clipboard holds a link.
  url: string | null
}

// What the clipboard holds, without reading it.
export type ClipboardKinds = {
  // Probably a web link.
  url: boolean
  text: boolean
}

export type PasteOptions = {
  // The sheet's title, e.g. "Paste a link".
  title?: string
  // A line under the title, e.g. "MakerWorld, Printables or Thingiverse".
  message?: string
}

// The system clipboard. Reading asks the person once per hob, and on iOS the
// system also shows its own "Allow Paste" prompt, so read in response to a tap.
// In a browser, use navigator.clipboard instead.
export const clipboard = {
  read: () => call<ClipboardContents>('clipboard', 'read'),
  writeText: (text: string) => call<void>('clipboard', 'write', { text }),
  // Whether the clipboard holds a link or text, without reading it and without
  // a prompt, e.g. to show a "Use copied link" row.
  detect: () => call<ClipboardKinds>('clipboard', 'detect'),
  // iOS: a native sheet with the system Paste button. Tapping it hands the
  // clipboard to the page without the "Allow Paste" prompt or the per-hob
  // question; closing the sheet rejects with "cancelled".
  paste: (options: PasteOptions = {}) => call<ClipboardContents>('clipboard', 'paste', options),
}
