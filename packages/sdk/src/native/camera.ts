import { call, NativeError, on } from './bridge.ts'

// UPC-A codes are EAN-13 codes that start with 0: asking for 'upca' reports
// those as 'upca' with 12 digits.
export type CameraSymbology =
  | 'ean13'
  | 'ean8'
  | 'upca'
  | 'upce'
  | 'code39'
  | 'code93'
  | 'code128'
  | 'itf14'
  | 'i2of5'
  | 'codabar'
  | 'gs1DataBar'
  | 'qr'
  | 'microQR'
  | 'dataMatrix'
  | 'pdf417'
  | 'microPDF417'
  | 'aztec'
  | 'msiPlessey'

// A part of the camera view, as fractions of its width and height from the
// top left.
export type CameraRect = { x: number; y: number; width: number; height: number }

export type CameraCode = {
  // Stays the same while the code stays in view.
  id: string
  payload: string
  symbology: CameraSymbology
  bounds: CameraRect
}

export type CameraPhotoOptions = {
  // The longer side in pixels, 100 to 4096. Default 1600.
  maxDimension?: number
  // JPEG quality, 0.1 to 1. Default 0.8.
  quality?: number
}

export type CameraPhoto = { blob: Blob; width: number; height: number }

// A button under the viewfinder, e.g. { id: 'ai', label: 'Read the label with AI' }.
export type CameraButton = { id: string; label: string }

export type CameraScanEnd = {
  // selected: a code was read (the first one, or the one tapped with
  // multiple). stopped: the page stopped it. cancelled: the person closed the
  // scanner. failed: the camera stopped working, e.g. another app took it.
  reason: 'selected' | 'stopped' | 'cancelled' | 'failed'
  code?: CameraCode
  message?: string
}

export type CameraScanOptions = {
  // Leave out for every kind of barcode.
  symbologies?: CameraSymbology[]
  // Keep scanning and report every code in view; the scan ends when the
  // person taps one. Default false: the first code read ends it.
  multiple?: boolean
  torch?: boolean
  // The status under the viewfinder, e.g. "Still looking for a barcode".
  guidance?: string
  // Only read codes inside this part of the view.
  regionOfInterest?: CameraRect
  // A shutter button that takes a photo (onPhoto) without ending the scan.
  shutter?: boolean
  // Size and quality of the shutter's photos.
  photo?: CameraPhotoOptions
  // At most 3, shown under the viewfinder; a tap calls onButton.
  buttons?: CameraButton[]
  // The codes in view whenever they change.
  onCodes?: (codes: CameraCode[]) => void
  onButton?: (id: string) => void
  onPhoto?: (photo: CameraPhoto) => void
  // The person switched the torch in the scanner.
  onTorch?: (on: boolean) => void
  onEnd?: (end: CameraScanEnd) => void
}

export type CameraScan = {
  // Resolves when the scan ends, for whatever reason.
  ended: Promise<CameraScanEnd>
  // Closes the scanner.
  stop(): Promise<void>
  // A still photo from the running viewfinder, e.g. of the label behind the
  // barcode just read.
  capture(options?: CameraPhotoOptions): Promise<CameraPhoto>
  setTorch(on: boolean): Promise<void>
  setGuidance(text: string): Promise<void>
}

type PhotoReply = { data: string; width: number; height: number; type?: string }
type ScanEvent = { session: string } & Record<string, unknown>
const EVENTS = ['codes', 'button', 'photo', 'torch', 'ended'] as const
type EventName = (typeof EVENTS)[number]

export function decodePhoto(reply: PhotoReply): CameraPhoto {
  const binary = atob(reply.data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { blob: new Blob([bytes], { type: reply.type ?? 'image/jpeg' }), width: reply.width, height: reply.height }
}

async function scan(options: CameraScanOptions = {}): Promise<CameraScan> {
  const { onCodes, onButton, onPhoto, onTorch, onEnd, ...args } = options
  let id: string | undefined
  let done = false
  let resolveEnded!: (end: CameraScanEnd) => void
  const ended = new Promise<CameraScanEnd>((resolve) => (resolveEnded = resolve))
  // Events can arrive before startScan answers.
  const early: [EventName, ScanEvent][] = []
  const handle = (event: EventName, data: ScanEvent) => {
    if (id === undefined) {
      early.push([event, data])
      return
    }
    if (data.session !== id || done) return
    switch (event) {
      case 'codes':
        onCodes?.(data.codes as CameraCode[])
        return
      case 'button':
        onButton?.(data.id as string)
        return
      case 'photo':
        onPhoto?.(decodePhoto(data as unknown as PhotoReply))
        return
      case 'torch':
        onTorch?.(data.on === true)
        return
    }
    done = true
    for (const stop of stops) stop()
    const end: CameraScanEnd = { reason: data.reason as CameraScanEnd['reason'] }
    if (data.code) end.code = data.code as CameraCode
    if (typeof data.message === 'string') end.message = data.message
    onEnd?.(end)
    resolveEnded(end)
  }
  const stops = EVENTS.map((event) => on<ScanEvent>(`camera.${event}`, (data) => handle(event, data)))
  try {
    id = (await call<{ session: string }>('camera', 'startScan', args)).session
  } catch (err) {
    for (const stop of stops) stop()
    throw err
  }
  for (const [event, data] of early.splice(0)) handle(event, data)
  return {
    ended,
    async stop() {
      if (done) return
      await call('camera', 'stopScan', { session: id })
    },
    async capture(photo: CameraPhotoOptions = {}) {
      return decodePhoto(await call<PhotoReply>('camera', 'capture', { session: id, ...photo }))
    },
    async setTorch(on: boolean) {
      await call('camera', 'setTorch', { session: id, on })
    },
    async setGuidance(guidance: string) {
      await call('camera', 'updateScan', { session: id, guidance })
    },
  }
}

// The camera, over the hob's page (iOS on devices with a camera; not on Macs).
// Asks the person once per hob, and iOS asks once for Hobwork. Errors:
// "denied" (the person said no here or in the Settings app), "unavailable"
// with reason "unsupported" or "restricted", "failed" with reason "busy"
// (another scan or photo is open).
export const camera = {
  // A live barcode scanner that streams codes in view and ends on a code, a
  // stop or the close button. It can also take photos while it runs.
  scan,
  // Scans until one code is read: the code, or null when the person closes
  // the scanner.
  async scanCode(options: Omit<CameraScanOptions, 'multiple' | 'onEnd'> = {}): Promise<CameraCode | null> {
    const end = await (await scan({ ...options, multiple: false })).ended
    if (end.reason === 'failed') throw new NativeError('failed', end.message ?? 'The camera stopped')
    return end.code ?? null
  },
  // Takes one photo with the system camera. Rejects with "cancelled" when the
  // person closes it.
  async photo(options: CameraPhotoOptions = {}): Promise<CameraPhoto> {
    return decodePhoto(await call<PhotoReply>('camera', 'photo', options))
  },
}
