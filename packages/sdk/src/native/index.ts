// Native features of the Hobwork app for hob UIs: haptics, printing, the
// share sheet, the clipboard, local notifications, NFC, alarms, the camera,
// Live Activities, Apple Home (rooms and names), opened links and app info.
// Everything feature-detects: outside the app (a browser)
// `native.available` is false and calls reject with NativeError code
// "unavailable".
//
//   import { native } from '@hobwork/sdk/native'
//   if (native.has('haptics')) await native.haptics.success()

import { alarms } from './alarms.ts'
import { app } from './app.ts'
import { available, call, has, on, platform } from './bridge.ts'
import { camera } from './camera.ts'
import { clipboard } from './clipboard.ts'
import { haptics } from './haptics.ts'
import { homekit } from './homekit.ts'
import { liveActivities } from './live-activities.ts'
import { links } from './links.ts'
import { nfc } from './nfc.ts'
import { notifications } from './notifications.ts'
import { print } from './print.ts'
import { share } from './share.ts'

export { NativeError } from './bridge.ts'
export type { NativeBridge, NativeData, NativeErrorCode, NativePlatform, NativeReply } from './bridge.ts'
export type { AppInfo } from './app.ts'
export type {
  CameraButton,
  CameraCode,
  CameraPhoto,
  CameraPhotoOptions,
  CameraRect,
  CameraScan,
  CameraScanEnd,
  CameraScanOptions,
  CameraSymbology,
} from './camera.ts'
export type { NativeAlarm, NativeAlarmEvent, NativeAlarmRepeat, NativeTimer } from './alarms.ts'
export type {
  NfcDevice,
  NfcScanned,
  NfcSession,
  NfcSessionEnd,
  NfcSessionOptions,
  NfcSheet,
  NfcTag,
  NfcTagRecord,
  NfcWrite,
  NfcWriteResult,
} from './nfc.ts'
export type { ClipboardContents, ClipboardKinds, PasteOptions } from './clipboard.ts'
export type { LinkOpened } from './links.ts'
export type { ImpactStyle } from './haptics.ts'
export type { HomeKitAccessory, HomeKitHome } from './homekit.ts'
export type { LiveActivityStatus } from './live-activities.ts'
export type { LocalNotification } from './notifications.ts'
export type { MediaSize, Printer, PrintOptions, PrintResult } from './print.ts'
export type { ShareContent } from './share.ts'
export { createFakeBridge } from './fake.ts'
export type { FakeBridge, FakeHandler } from './fake.ts'

export const native = {
  // True inside the Hobwork app on a hob's own origin.
  get available() {
    return available()
  },
  get platform() {
    return platform()
  },
  has,
  call,
  on,
  alarms,
  app,
  camera,
  clipboard,
  haptics,
  homekit,
  liveActivities,
  links,
  nfc,
  notifications,
  print,
  share,
}
