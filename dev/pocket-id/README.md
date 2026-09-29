# Pocket ID test instance

Local [Pocket ID](https://pocket-id.org) in Docker for developing web UI sign-in. Setup is fully scripted through Pocket ID's admin API (static API key), including a user and the OIDC client, so no passkey is needed.

```
node dev/pocket-id/setup.ts              # start, create user and client, write .env.local (idempotent)
node dev/pocket-id/setup.ts login-link   # one-time link that signs you in to Pocket ID in the browser
node dev/pocket-id/smoke.ts [host-url]   # sign in to a running host end to end, without a browser
node dev/pocket-id/setup.ts down         # stop, keep state
node dev/pocket-id/setup.ts reset        # stop and wipe state
```

- URL: `http://localhost:11411`. User `household` (`household@hobwork.test`, Pocket ID admin). OIDC client `hobwork-dev` with callbacks for the Vite dev server (`http://hobwork.localhost:5173`) and the host (`http://hobwork.localhost:7420`), and the same on plain `localhost`.
- Pocket ID signs users in with passkeys. The one-time link from `login-link` replaces that for the dev user; it is valid for 15 minutes. You can also register a passkey on the account page afterwards.
- `.env.local` (gitignored) holds the host settings: `HOBWORK_OIDC_ISSUER`, `HOBWORK_OIDC_CLIENT_ID`, `HOBWORK_OIDC_CLIENT_SECRET`, `HOBWORK_ALLOWED_USERS`, `HOBWORK_PUBLIC_URL=http://hobwork.localhost:5173` and `HOBWORK_APPS_URL=http://apps.hobwork.localhost:7420`. Browsers resolve every `*.localhost` name to the loopback address, and `hobwork.localhost` and `filament.apps.hobwork.localhost` are the same site, so hob apps sign in inside the Hobwork UI's iframe. With Hobwork on plain `localhost` they would be a different site, and the iframe would not keep the app's session.

## Signing in to the dev web UI

1. `node dev/pocket-id/setup.ts`, then open the printed login link in the browser.
2. Start the host with the settings: `node --env-file=dev/pocket-id/.env.local server/src/index.ts` (or export them before `pnpm dev`), and the web UI with `pnpm -C web dev`.
3. Open `http://hobwork.localhost:5173` and sign in. Hob apps open at `http://<hob>.apps.hobwork.localhost:7420`.

To test the host serving the built UI instead, run `pnpm -C web build` and start the host with `HOBWORK_PUBLIC_URL=http://hobwork.localhost:7420`, which takes precedence over the value in the env file. `smoke.ts` expects this setup.

Automated tests do not need this instance: `server/src/auth/oidc.test.ts` runs the same flow against a fake provider (`server/src/auth/fake-oidc.ts`).
