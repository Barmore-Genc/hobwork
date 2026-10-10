import { call, encodeData, type NativeData } from './bridge.ts'

export type Printer = {
  // A printer URL on iOS, the printer's name on macOS.
  id: string
  name: string
  lastUsedAt: string
}

export type MediaSize = {
  width: number
  height: number
  // Default: pt (1/72 inch).
  unit?: 'pt' | 'mm' | 'in'
}

export type PrintOptions = {
  jobName?: string
  // The paper to print on; the printer's closest paper is used. Default: the
  // size of the PDF's first page.
  mediaSize?: MediaSize
  // A printer ID from printers() or an earlier print. With dialog: true (the
  // default) the dialog opens with it selected; with dialog: false the PDF
  // goes straight to it.
  printer?: string
  dialog?: boolean
  output?: 'general' | 'grayscale' | 'photo' | 'photoGrayscale'
}

export type PrintResult = {
  // The printer the person printed to, which the app remembers for this hob.
  printer: Printer | null
  // The paper the printer used, in points.
  paper: { width: number; height: number } | null
}

const POINTS = { pt: 1, mm: 72 / 25.4, in: 72 }

export function mediaPoints(size: MediaSize): { width: number; height: number } {
  const factor = POINTS[size.unit ?? 'pt']
  return { width: size.width * factor, height: size.height * factor }
}

// Printing through the system print dialog (AirPrint on iOS).
export const print = {
  // Prints a PDF: bytes, or a URL on the hob's origin. Rejects with
  // "cancelled" when the person closes the dialog.
  async pdf(pdf: NativeData, options: PrintOptions = {}): Promise<PrintResult> {
    const { mediaSize, ...rest } = options
    return call('print', 'pdf', { ...rest, data: await encodeData(pdf), ...(mediaSize ? { mediaSize: mediaPoints(mediaSize) } : {}) })
  },
  // Printers this hob printed to on this device, most recent first.
  printers: () => call<Printer[]>('print', 'printers'),
  forgetPrinter: (id: string) => call<void>('print', 'forgetPrinter', { id }),
  // The system printer picker (iOS only), which also remembers the choice.
  pickPrinter: (initial?: string) => call<Printer>('print', 'pickPrinter', initial ? { printer: initial } : {}),
}
