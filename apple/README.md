# Hobwork for iOS

SwiftUI app for iOS 26 (`dev.bgenc.hobwork`). It pairs with a Hobwork host, shows the web UI and project apps in a web view, keeps the device WebSocket open and shows notifications from projects. The protocol is in "Device protocol" in `docs/architecture.md`.

Needs Xcode 26 or newer, [XcodeGen](https://github.com/yonaskolb/XcodeGen) and [just](https://github.com/casey/just).

## Project

`project.yml` is the source of truth. `Hobwork.xcodeproj` is generated and gitignored:

```sh
just generate      # xcodegen generate
open Hobwork.xcodeproj
```

Every `just` recipe regenerates the project first. Targets:

- `Hobwork`: the app.
- `HobworkNotificationService`: notification service extension. Pushes with actions name a category `hobwork.<id>` that the app has never seen, so the extension registers it from the payload's `hobwork.actions` before iOS shows the notification.
- `HobworkTests`: unit tests (Swift Testing).
- `HobworkUITests`: a smoke test against a running host, skipped unless `just smoke` runs it.

## Build and run

```sh
just build                # build for the simulator
just run                  # newest iPhone simulator
just run "iPhone 17"      # a named one
just run-device           # first connected iPhone, signed with team 63QQLP356Q
just testflight            # archive a release build and upload it to App Store Connect
```

`testflight` signs with the Apple account signed in to Xcode and uploads to the Hobwork app record on App Store Connect. The build number is the UTC time of the build, so every upload is higher than the last.

On a device the first build needs the team's signing: open the project in Xcode once, or pass `-allowProvisioningUpdates` (the `install-device` recipe does). Push needs the Push Notifications capability on the `dev.bgenc.hobwork` App ID, which automatic signing adds from `Hobwork.entitlements`. The extension's App ID is `dev.bgenc.hobwork.NotificationService`.

Plain http works for `localhost`, `*.localhost`, `.local` names and IP addresses, so the app can pair with a development host at `http://hobwork.localhost:7420`. Everything else needs https.

## Tests

```sh
just test                           # unit tests on an iPhone simulator
just test-host <url> '<cookie>'     # device protocol against a running host
just smoke <url>                    # UI: fresh install, enter the address, open pairing
```

`test-host` needs the `Cookie` header of a signed-in person, since it approves the pairing through the host's API. With a local host:

```sh
pnpm --filter @hobwork/server sign-in-link you@example.com   # prints a link
curl -s -o /dev/null -c jar.txt '<link>'
grep session jar.txt | awk '{print $6"="$7}'                 # hobwork_session=...
just test-host http://hobwork.localhost:7420 'hobwork_session=...'
```

It pairs a device, asks for a web session, sets and clears the push token, connects the socket, then removes the device and checks that the app treats that as unpaired. It also signs a second device out with `DELETE /api/devices/self`.

`smoke` stops at the host's sign-in page unless the pairing sheet's browser is already signed in to the host.

## Push in the simulator

The simulator takes pushes from a file, without APNs:

```sh
just push                     # push/actions.apns to the booted simulator
just push path/to/other.apns
```

`push/actions.apns` has the payload the host sends: title and body in `aps.alert`, `category: "hobwork.<id>"` with `mutable-content: 1`, and `hobwork: { id, project, actions }`. Long-press the notification to see the actions. Tapping one sends `{ capability: "notifications", name: "action", data: { id, action } }` to the host, over the socket when connected and with `POST /api/devices/events` otherwise. Tapping the notification itself opens the project in the app.

For real pushes the host needs an APNs key (`HOBWORK_APNS_KEY_FILE`, `HOBWORK_APNS_KEY_ID`, `HOBWORK_APNS_TEAM_ID`). Debug builds register with the sandbox environment, release builds with production.
