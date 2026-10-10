# Hobwork for iOS and macOS

SwiftUI app for iOS 26 and macOS 26 (`dev.bgenc.hobwork`). It pairs with a Hobwork host, shows the web UI and hob apps in a web view, keeps the device WebSocket open, shows notifications from hobs and runs their device commands: alarms and timers, Screen Time, Focus, NFC tags and Health on iOS, Focus on macOS. The protocol is in "Device protocol" in `docs/architecture.md`.

Needs Xcode 26 or newer, [XcodeGen](https://github.com/yonaskolb/XcodeGen) and [just](https://github.com/casey/just).

## Project

`project.yml` is the source of truth. `Hobwork.xcodeproj` is generated and gitignored:

```sh
just generate      # xcodegen generate
open Hobwork.xcodeproj
```

Every `just` recipe regenerates the project first. Targets:

- `Hobwork`: the app, for iOS and macOS.
- `HobworkNotificationService`: notification service extension, for iOS and macOS. It opens sealed relay pushes and answers the relay's proof and renewal pushes (see Push). Pushes with actions name a category `hobwork.<id>` that the app has never seen, so the extension registers it from the payload's `hobwork.actions` before the system shows the notification. Command pushes (`hobwork.command` without `foreground`) run through the same command runner as the app, post the result to `POST /api/devices/results` and replace the notification text with a summary. When the extension runs out of time, the system shows the host's text.
- `HobworkDeviceActivityMonitor` (iOS only): DeviceActivity monitor extension. Applies and lifts Screen Time shields for schedules, daily limits and timed blocks, even when the app is not running.
- `HobworkWidgets` (iOS only): widget extension with the Live Activity AlarmKit shows for timers, with Pause, Resume, Cancel and Stop buttons. The buttons run `AlarmControlIntent` (`Hobwork/Alarms/AlarmControlIntent.swift`), a `LiveActivityIntent` that is part of both the app and the extension, as Apple requires; iOS runs it in the app, which AlarmKit authorized.
- `HobworkTests`: unit tests (Swift Testing), for iOS and macOS. Tests of iOS-only capabilities are in `HobworkTests/iOS/`.
- `HobworkUITests` (iOS only, own scheme): a smoke test against a running host, skipped unless `just smoke` runs it.

Sources in `Hobwork/Shared/` are compiled into the app and the notification service extension: the command runner (`Commands/`), the host API and credentials, and the capabilities that run without the app on screen. The monitor and widget extensions take only the files they need (see `project.yml`). NFC, the Focus filter and Health background delivery are in `Hobwork/Capabilities/`, app only.

The `Hobwork` scheme builds for both platforms from one target. macOS 26 has no AlarmKit or Core NFC, ManagedSettings and most of DeviceActivity are unavailable there, and HealthKit has no data on a Mac (`HKHealthStore.isHealthDataAvailable()` is false), so `project.yml` compiles the alarms, Screen Time, NFC and Health sources for iOS only (`destinationFilters`) and the code around them checks `#if os(iOS)`. The macOS app reports `notifications` and `focus` in `hello`. It has one window and a Settings window (⌘,), keeps running with the window closed so the socket stays open, and reconnects when the Mac wakes.

State shared with the extensions lives in the app group `group.dev.bgenc.hobwork`: JSON files for command IDs already run (1 day), notification and command IDs already handled (1 day), the last proof nonce from the relay, Screen Time app sets and rules, Focus labels, Health sharing and anchors, and alarm titles. Device credentials, the relay registration and each pairing's push keys and grant are in the Keychain under the app group's access group; items from earlier versions move there on the first launch.

## Entitlements and build settings

| Target | Entitlements |
| --- | --- |
| Hobwork | Push, App Attest, App Groups, HealthKit with background delivery, NFC tag reading, Family Controls, Associated Domains (optional) |
| HobworkNotificationService | App Groups, HealthKit, Family Controls |
| HobworkDeviceActivityMonitor | App Groups, Family Controls |
| HobworkWidgets | App Groups |
| Hobwork (macOS) | Push, App Attest, App Sandbox with outgoing connections, App Groups |
| HobworkNotificationService (macOS) | App Sandbox with outgoing connections, App Groups |

The App Attest entitlement says `development`; TestFlight and App Store builds use the production environment whatever it says. The macOS targets use the `-macOS` files (`CODE_SIGN_ENTITLEMENTS[sdk=macosx*]`) and the hardened runtime.

Two build settings pick the iOS entitlements files:

- `HOBWORK_FAMILY_CONTROLS` (default `YES`): `NO` signs every target without Family Controls (the `-NoFamilyControls` files). The development entitlement works for Xcode builds; TestFlight and the App Store need the distribution entitlement, which Apple approves on request. Until then `just testflight` archives with `NO`, and that build does not offer Screen Time.
- `HOBWORK_APPLINKS_HOST` (default empty): a host name such as `hobwork.example.com` adds `applinks:<host>` and `webcredentials:<host>` (the `-AppLinks` files), so NFC tags with `https://<host>/nfc/<tag>` open the app and pairing with that host finishes on the universal link `https://<host>/devices/paired`, which only this app can claim. Pairing with any other host falls back to `hobwork://paired`. The host serves the matching `apple-app-site-association`.

For example `xcodebuild ... HOBWORK_APPLINKS_HOST=hobwork.example.com`.

## Build and run

```sh
just build                # build for the simulator
just run                  # newest iPhone simulator
just run "iPhone 17"      # a named one
just run-device           # first connected iPhone, signed with team 63QQLP356Q
just testflight            # archive a release build and upload it to App Store Connect
```

`testflight` signs with the Apple account signed in to Xcode, without Family Controls, and uploads to the Hobwork app record on App Store Connect. The build number is the UTC time of the build, so every upload is higher than the last.

On a device the first build needs the team's signing: open the project in Xcode once, or pass `-allowProvisioningUpdates` (the `install-device` recipe does). Automatic signing adds the capabilities from the entitlements files to the App IDs `dev.bgenc.hobwork`, `dev.bgenc.hobwork.NotificationService`, `dev.bgenc.hobwork.DeviceActivityMonitor` and `dev.bgenc.hobwork.Widgets`, and registers the app group `group.dev.bgenc.hobwork`, as long as an Apple account of team 63QQLP356Q is signed in to Xcode. If it can't, enable them in the developer portal (Certificates, Identifiers & Profiles): App Groups with `group.dev.bgenc.hobwork` on all four App IDs, HealthKit (with background delivery) and NFC Tag Reading on the app, HealthKit on the notification service extension, Family Controls (Development) on the app, the notification service extension and the monitor, and Associated Domains on the app when `HOBWORK_APPLINKS_HOST` is set.

### macOS

```sh
just build-mac            # build for this Mac, signed with team 63QQLP356Q
just run-mac              # build and open it
just run-mac local        # signed to run on this Mac only
```

Team signing needs an Apple account of team 63QQLP356Q in Xcode, as for iPhone builds; `-allowProvisioningUpdates` registers the Mac and adds the macOS platform to the App IDs `dev.bgenc.hobwork` and `dev.bgenc.hobwork.NotificationService`. Both apps share the bundle ID, so pushes use the same APNs topic. With `local` (all macOS recipes take it), the app is signed ad hoc with `Hobwork/Hobwork-macOS-Local.entitlements`: it pairs, shows the web UI and keeps the socket open, but gets no push token, has no app group, and keeps its device token in the file-based keychain, since the data protection keychain needs a provisioning profile.

Plain http works for `localhost`, `*.localhost`, `.local` names and IP addresses, so the app can pair with a development host at `http://hobwork.localhost:7420`. Everything else needs https.

## Tests

```sh
just test                           # unit tests on an iPhone simulator
just test-mac                       # unit tests on this Mac (`just test-mac local` without the team)
just test-host <url> '<cookie>'     # device protocol against a running host
just test-host-mac <url> '<cookie>' # the same from the macOS app, which pairs as `macos`
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

## Device capabilities

The app lists a capability in `hello` only when it is set up and allowed. People set them up under Settings in the app: allow alarms, allow Screen Time and create app sets (a name such as `social` and apps, categories and websites from the system picker), choose the Health types to share, and add the Hobwork Focus filter to a Focus in the Settings app. NFC needs no setup; Settings has a "Scan Tag" button that sends any tag's link to the host. `hobwork://nfc/<tag>` and, with Associated Domains, `https://<host>/nfc/<tag>` report the tag as scanned. On macOS, Settings has only notifications and Focus; the Focus filter is added in System Settings, Focus.

The app sends only what a person explicitly chose to share. It sends no location, no device identifiers (`identifierForVendor`, the advertising ID), no Wi-Fi or network names, and nothing else that could look like tracking. New capabilities follow this rule.

`Hobwork/Capabilities/NFC/NFCIntents.swift` has two App Intents for tags with other links, which iOS opens in Safari: "Scan NFC Tag" opens the app and scans (Action Button, Control Center, Siri), and "Send Tag to Hobwork" sends a link to the host in the background, for a Shortcuts personal automation "When I tap an NFC tag". See "Tags with other links" in `docs/architecture.md`.

A command arrives over the socket, by a command push the notification service extension runs, or by a prompt push (NFC, alarms) that the app runs when tapped. AlarmKit authorizes the app and the extension separately, and the extension cannot ask, so alarm commands always run in the app. A tapped alarms command asks for AlarmKit authorization first when it is not set up, then opens the Alarms and Timers screen (`Hobwork/Alarms/`, also under Settings), which lists Hobwork's alarms and timers from AlarmManager with their titles from the app group, and lets people pause, resume, stop and cancel them. When the command fails, the screen opens with an alert that says why. AlarmKit does not tell the app when a timer ends, so the screen reads the countdown from the timer's Live Activity. The command log in the app group makes each command run once and answers repeats with the first result.

Unit tests cover argument checks, command dedup and expiry, result, event and sample encoding, Screen Time intervals and the monitor's actions, alarm schedules, the alarms screen's rows and what follows a tapped alarms command, NFC links and records, and the notification summaries. What only a device can show:

- Screen Time: the Family Controls prompt, the app picker, shields from ManagedSettings, and that DeviceActivity calls the monitor extension at interval start, end and threshold (limits, schedules, the end of timed blocks).
- Commands run by the notification service extension: whether ManagedSettings, DeviceActivity and HealthKit calls work from it at runtime (AlarmKit does not: on an iPad the extension's authorization stays `notDetermined`), how long they take against the 30 second limit, and that the summary replaces the text.
- AlarmKit alarms and timers ringing, the timer's Live Activity and its buttons, the authorization prompt after tapping an alarm prompt push, and the countdown on the Alarms and Timers screen (read from `Activity.activities`).
- NFC reading and writing (the simulator has no NFC), universal links, and iOS background tag reading.
- The Scan NFC Tag and Send Tag to Hobwork actions from Shortcuts, the Action Button and a "When I tap an NFC tag" automation.
- Health: authorization, queries while locked (`locked`) and background delivery waking the app.
- The Focus filter running when a Focus turns on and off, on iOS and macOS.
- On macOS with team signing: the push token, pushes with actions and command pushes through the notification service extension, and the credentials in the app group's keychain access group.
- Relay pushes: App Attest registration and assertions (and whether a Mac supports them), the proof push reaching the extension and the app, renewal background pushes waking the app, sealed pushes opened by the extension on iOS and macOS, and that the extension cannot make assertions for the app's key.

## Push

Pushes go through the push relay at `https://relay.bgenc.dev` (`RelayClient.builtInURL`), as "Hosts and apps on the relay" in `docs/architecture.md` describes. The code is in `Hobwork/Shared/Push/` (relay client, App Attest, sealing, storage, opening pushes) and `Hobwork/Push/PushCoordinator.swift` (the app's registration and grants).

- **Registration**: when an APNs token arrives, the app creates or updates the device's one relay registration, attested with App Attest where `DCAppAttestService` is supported (not in the simulator, maybe not on a Mac) and without it otherwise. Requests of an attested registration carry an assertion and go one at a time. The relay answers with an ownership proof push: the extension writes its nonce to the app group and, for a registration without App Attest, sends it to the relay itself. App Attest keys belong to the app's bundle ID, so for an attested registration the app sends the nonce. It waits up to 3 minutes and asks for another proof push every 30 seconds. A registration whose token is gone registers the token again, and one the relay no longer knows starts over.
- **Grants**: the host sends its push keys in the token exchange answer and in the `push` message after every `hello`. The app uses push with a host only when its `relay` is the built-in URL. Per pairing it keeps a random pairing ID, an X25519 key pair, the host's keys and a grant for the host's signing key, made once the registration is active and replaced when the signing key changes. The host gets `{ grant, key }` in `hello` and with `PUT /api/devices/push`, and `{ grant: null }` when push is off for it. Grants with less than 15 days left are renewed when the app starts or comes to the foreground, and when a renewal push (a background push) lists them.
- **Opening**: the extension finds the pairing by grant, opens the push, and rebuilds the notification from the sealed `aps` with the sealed `hobwork` in `userInfo`, so commands, actions and taps work as with unsealed pushes. A push that does not open, has expired, was sent more than 5 minutes ahead of the device's clock, or repeats a notification or command already handled, including over the socket, keeps the relay's text. The app hides repeats while it is in the foreground.

The extension cannot hide a push, so the proof push shows "Notifications from Hobwork are set up." once per token, and dropped pushes show the relay's generic text.

## Push in the simulator

The simulator takes pushes from a file, without APNs:

```sh
just push                     # push/actions.apns to the booted simulator
just push path/to/other.apns
```

`push/actions.apns` has the payload the host sends: title and body in `aps.alert`, `category: "hobwork.<id>"` with `mutable-content: 1`, and `hobwork: { id, project, actions }`. Long-press the notification to see the actions. `push/timer.apns` is a command push (the extension runs it once the app is paired) and `push/nfc.apns` a prompt push for an NFC read that runs when tapped. Tapping one sends `{ capability: "notifications", name: "action", data: { id, action } }` to the host, over the socket when connected and with `POST /api/devices/events` otherwise. Tapping the notification itself opens the hob in the app.

These payloads are unsealed, which the extension still handles. Sealed pushes need a grant from the relay. The macOS app has no simulator; pushes to it go through APNs and the relay. Debug builds register with the sandbox environment and App Attest's development environment, release builds with production.
