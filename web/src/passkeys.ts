import { browserSupportsWebAuthn, WebAuthnError } from '@simplewebauthn/browser'
import { ApiError } from './api.ts'

export const passkeysSupported = browserSupportsWebAuthn

export function passkeyError(err: unknown): string {
  if (err instanceof ApiError) return err.message
  const name = err instanceof WebAuthnError ? (err.cause as Error | undefined)?.name : (err as Error | undefined)?.name
  if (err instanceof WebAuthnError && err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
    return 'This device already has a passkey for Hobwork.'
  }
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey prompt was closed. Try again when you are ready.'
  return err instanceof Error ? err.message : String(err)
}

// A starting name for a new passkey, so the list tells devices apart.
export function deviceName(): string {
  const agent = navigator.userAgent
  if (/iPhone/.test(agent)) return 'iPhone'
  if (/iPad/.test(agent)) return 'iPad'
  if (/Android/.test(agent)) return 'Android'
  if (/Mac OS X|Macintosh/.test(agent)) return 'Mac'
  if (/Windows/.test(agent)) return 'Windows'
  if (/Linux/.test(agent)) return 'Linux'
  return 'Passkey'
}
