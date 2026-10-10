import { call, on } from './bridge.ts'

export type NfcTagRecord = { type: 'url' | 'text' | 'other'; value: string }

export type NfcTag = {
  records: NfcTagRecord[]
  // The tag's hardware ID (UID) as lowercase hex.
  uid?: string
  // Set when the tag is a Hobwork tag of this host (<host>/nfc/<tag>).
  tag?: string
}

// What the system scan sheet says while it waits, and once the tag is done.
export type NfcSheet = { alertMessage?: string; successMessage?: string }

// Another of your devices, for iPads and Macs without NFC: a device name as
// ctx.device() takes it, or "lastActive" for the one you used last that has NFC.
export type NfcDevice = string

export type NfcWrite = NfcSheet & {
  // The link to write. Required without device; with device, leaving it out
  // writes a new Hobwork tag owned by this hob.
  url?: string
  text?: string
  device?: NfcDevice
}

export type NfcWriteResult = {
  url: string
  // Set for a new Hobwork tag.
  tag?: string
  uid?: string
  // The tag read back what was written in the same tap.
  verified?: boolean
  // The device that wrote it, when it was another one.
  device?: string
}

export type NfcScanned = { url: string; tag?: string }

export type NfcSessionEnd = {
  // stopped: the page stopped it. timeout: iOS ends sessions after 60 seconds;
  // start a new one to keep listening. cancelled: the person closed the sheet.
  // failed: anything else, such as the app leaving the screen or another session.
  reason: 'stopped' | 'timeout' | 'cancelled' | 'failed'
  message?: string
}

export type NfcSessionOptions = NfcSheet & {
  // Keep listening after each tag until stop() or iOS ends it. Default false:
  // the session ends after the first tag.
  keepOpen?: boolean
  // Called for each tag. Return a string to change what the sheet says next,
  // e.g. "Bin 4. Now tap the spool."
  onTag: (tag: NfcTag) => void | string | Promise<void | string>
  onEnd?: (end: NfcSessionEnd) => void
}

export type NfcSession = {
  // Closes the sheet, showing message as done.
  stop(message?: string): Promise<void>
  // Resolves when the session ends, for whatever reason.
  ended: Promise<NfcSessionEnd>
}

type SessionEvent = { session: string } & Record<string, unknown>

// Errors: "cancelled" when the person closes the sheet, "unavailable" on a
// device without NFC (pass device to use another one), "failed" with reason
// "not_writable", "too_small", "verify_failed" or "timeout" (the other device
// did not answer in two minutes; it may still write the tag).
export const nfc = {
  read: (sheet: NfcSheet & { device?: NfcDevice } = {}) => call<NfcTag & { device?: string }>('nfc', 'read', sheet),
  // Writes a link and reads it back in the same tap. With device, the other
  // device shows a notification to tap and the call waits up to two minutes.
  write: (write: NfcWrite) => call<NfcWriteResult>('nfc', 'write', write),
  // Reads tags one after another in one sheet: a scan chain, or a bin that
  // keeps listening. One session at a time per device; starting another ends
  // the first with "failed".
  async session(options: NfcSessionOptions): Promise<NfcSession> {
    const { onTag, onEnd, ...args } = options
    let id: string | undefined
    let done = false
    let resolveEnded!: (end: NfcSessionEnd) => void
    const ended = new Promise<NfcSessionEnd>((resolve) => (resolveEnded = resolve))
    // Events can arrive before startSession answers.
    const early: ['tag' | 'ended', SessionEvent][] = []
    const handle = (event: 'tag' | 'ended', data: SessionEvent) => {
      if (id === undefined) {
        early.push([event, data])
        return
      }
      if (data.session !== id || done) return
      if (event === 'tag') {
        const { session: _, ...tag } = data
        void Promise.resolve(onTag(tag as unknown as NfcTag)).then((next) => {
          if (typeof next === 'string' && !done) {
            call('nfc', 'updateSession', { session: id, alertMessage: next }).catch(() => {})
          }
        })
        return
      }
      done = true
      stopTag()
      stopEnded()
      const end: NfcSessionEnd = { reason: data.reason as NfcSessionEnd['reason'] }
      if (typeof data.message === 'string') end.message = data.message
      onEnd?.(end)
      resolveEnded(end)
    }
    const stopTag = on<SessionEvent>('nfc.tag', (data) => handle('tag', data))
    const stopEnded = on<SessionEvent>('nfc.ended', (data) => handle('ended', data))
    try {
      id = (await call<{ session: string }>('nfc', 'startSession', args)).session
    } catch (err) {
      stopTag()
      stopEnded()
      throw err
    }
    for (const [event, data] of early.splice(0)) handle(event, data)
    return {
      ended,
      async stop(message?: string) {
        if (done) return
        await call('nfc', 'stopSession', { session: id, ...(message ? { successMessage: message } : {}) })
      },
    }
  },
  // A tag scanned outside the page while it is open: iOS background reading of
  // a Hobwork tag of this hob, or of a link to this hob, opened the app. The
  // app stays on the page.
  onScanned: (listener: (scan: NfcScanned) => void) => on<NfcScanned>('nfc.scanned', listener),
}
