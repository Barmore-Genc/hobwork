// Usage: node dev/pocket-id/smoke.ts [host-url]
// Signs in to a running host through the dev Pocket ID without a browser and
// prints the session. The host must use the settings from .env.local, with
// HOBWORK_PUBLIC_URL set to the host URL (default http://localhost:7420).
import { loginLink } from './setup.ts'

const hostUrl = process.argv[2] ?? 'http://localhost:7420'

class Jar {
  cookies = new Map<string, string>()
  take(res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const pair = header.split(';')[0]!
      const eq = pair.indexOf('=')
      this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
  }
  get header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

async function step(url: string, jar: Jar, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    redirect: 'manual',
    ...init,
    headers: { cookie: jar.header, ...(init.headers as Record<string, string>) },
  })
  jar.take(res)
  return res
}

function expectRedirect(res: Response, what: string): URL {
  const location = res.headers.get('location')
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new Error(`${what}: expected a redirect, got ${res.status}`)
  }
  return new URL(location, res.url)
}

const idp = new Jar()
const link = new URL(await loginLink())
const token = link.pathname.split('/').pop()!
const exchange = await step(`${link.origin}/api/one-time-access-token/${token}`, idp, { method: 'POST' })
if (!exchange.ok) throw new Error(`One-time token exchange failed: ${exchange.status} ${await exchange.text()}`)

const hostJar = new Jar()
let next = expectRedirect(await step(`${hostUrl}/auth/login?returnTo=/agents`, hostJar), 'Host login')

for (let i = 0; i < 5 && next.origin === link.origin; i++) {
  const interaction = next.searchParams.get('interaction')
  if (next.pathname === '/interaction' && interaction) {
    const session = await (await step(`${link.origin}/api/oidc/interactions/${interaction}`, idp)).json()
    const res = await step(`${link.origin}/api/oidc/interactions/${interaction}/complete`, idp, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: session.currentStep }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(`Interaction step ${session.currentStep} failed: ${JSON.stringify(body)}`)
    next = new URL(body.redirectUrl ?? `/interaction?interaction=${interaction}`, link.origin)
  } else {
    next = expectRedirect(await step(next.href, idp), `Pocket ID ${next.pathname}`)
  }
}

const callback = await step(next.href, hostJar)
const landing = expectRedirect(callback, 'Host callback')
if (landing.pathname !== '/agents') throw new Error(`Sign-in failed, host redirected to ${landing.pathname}${landing.search}`)

const session = await (await step(`${hostUrl}/api/session`, hostJar)).json()
if (!session.user) throw new Error(`No user in session: ${JSON.stringify(session)}`)
console.log(`Signed in as ${session.user.name} <${session.user.email}>`)
