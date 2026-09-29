import { randomBytes } from 'node:crypto'
import { s256 } from '../oauth/secrets.ts'
import { writeHeaders } from '../test-web.ts'

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: s256(verifier) }
}

// Approves a pairing as the signed-in person behind `cookie` and exchanges the
// code the way the app does.
export async function pairDevice(
  base: string,
  cookie: string,
  options: { deviceName?: string; name?: string; platform?: string } = {},
): Promise<{ deviceId: number; name: string; token: string }> {
  const { verifier, challenge } = pkce()
  const approve = await fetch(`${base}/api/devices/pairing/approve`, {
    method: 'POST',
    headers: writeHeaders(cookie),
    body: JSON.stringify({
      request: {
        name: options.deviceName ?? "Kaan's iPhone",
        platform: options.platform ?? 'ios',
        challenge,
        state: 'xyz',
        redirect_uri: 'hobwork://paired',
      },
      name: options.name ?? 'kaan-iphone',
    }),
  })
  if (!approve.ok) throw new Error(`Approving failed: ${approve.status} ${await approve.text()}`)
  const { redirectTo } = (await approve.json()) as { redirectTo: string }
  const code = new URL(redirectTo).searchParams.get('code')
  const res = await fetch(`${base}/api/devices/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier: verifier }),
  })
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as { deviceId: number; name: string; token: string }
}
