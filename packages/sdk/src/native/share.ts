import { call, encodeData, type NativeData } from './bridge.ts'

export type ShareContent = {
  // A file: bytes, or a URL on the hob's origin.
  file?: NativeData
  // The name the file is shared under, e.g. "label.pdf".
  filename?: string
  url?: string
  text?: string
}

// Opens the share sheet. Resolves with the chosen activity (e.g.
// "com.apple.UIKit.activity.Mail" on iOS, the service's title on macOS),
// rejects with "cancelled" when the person closes it.
export async function share(content: ShareContent): Promise<{ activity: string | null }> {
  const { file, ...rest } = content
  return call('share', 'show', { ...rest, ...(file === undefined ? {} : { data: await encodeData(file) }) })
}
