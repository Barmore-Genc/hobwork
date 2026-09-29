# Hobwork for iOS

SwiftUI app for iOS 26 (`dev.bgenc.hobwork`). It pairs with a Hobwork host, shows the web UI and project apps in a web view, keeps the device WebSocket open, shows notifications from projects and runs their device commands: alarms and timers, Screen Time, Focus, NFC tags and Health. The protocol is in "Device protocol" in `docs/architecture.md`.

Needs Xcode 26 or newer, [XcodeGen](https://github.com/yonaskolb/XcodeGen) and [just](https://github.com/casey/just).

## Project

`project.yml` is the source of truth. `Hobwork.xcodeproj` is generated and gitignored:

```sh
just generate      # xcodegen generate
open Hobwork.xcodeproj
```

Every `just` recipe regenerates the project first. Targets:

- `Hobwork`: the app.
- `HobworkNotificationService`: notification service extension. Pushes with actions name a category `hobwork.<id>` that the app has never seen, so the extension registers it from the payload's `hobwork.actions` before iOS shows the notification. Command pushes (`hobwork.command` without `foreground`) run through the same command runner as the app, post the result to `POST /api/devices/results` and replace the notification text with a summary. When the extension runs out of time, iOS shows the host's text.
- `HobworkDeviceActivityMonitor`: DeviceActivity monitor extension. Applies and lifts Screen Time shields for schedules, daily limits and timed blocks, even when the app is not running.
- `HobworkWidgets`: widget extension with the Live Activity AlarmKit shows for timers.
- `HobworkTests`: unit tests (Swift Testing).
- `HobworkUITests`: a smoke test against a running host, skipped unless `just smoke` runs it.

Sources in `Hobwork/Shared/` are compiled into the app and the notification service extension: the command runner (`Commands/`), the host API and credentials, and the capabilities that run without the app on screen. The monitor and widget extensions take only the files they need (see `project.yml`). NFC, the Focus filter and Health background delivery are in `Hobwork/Capabilities/`, app only.

State shared with the extensions lives in the app group `group.dev.bgenc.hobwork`: JSON files for command IDs already run (1 day), Screen Time app sets and rules, Focus labels, Health sharing and anchors, and alarm titles. Device credentials are in the Keychain under the app group's access group; items from earlier versions move there on the first launch.

## Entitlements and build settings

| Target | Entitlements |
| --- | --- |
| Hobwork | Push, App Groups, HealthKit with background delivery, NFC tag reading, Family Controls, Associated Domains (optional) |
| HobworkNotificationService | App Groups, HealthKit, Family Controls |
| HobworkDeviceActivityMonitor | App Groups, Family Controls |
| HobworkWidgets | App Groups |

Two build settings pick the entitlements files:

- `HOBWORK_FAMILY_CONTROLS` (default `YES`): `NO` signs every target without Family Controls (the `-NoFamilyControls` files). The development entitlement works for Xcode builds; TestFlight and the App Store need the distribution entitlement, which Apple approves on request. Until then `just testflight` archives with `NO`, and that build does not offer Screen Time.
- `HOBWORK_APPLINKS_HOST` (default empty): a host name such as `hobwork.example.com` adds `applinks:<host>` (the `-AppLinks` files), so NFC tags with `https://<host>/nfc/<tag>` open the app. The host serves the matching `apple-app-site-association`.

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

## Device capabilities

The app lists a capability in `hello` only when it is set up and allowed. People set them up under Settings in the app: allow alarms, allow Screen Time and create app sets (a name such as `social` and apps, categories and websites from the system picker), choose the Health types to share, and add the Hobwork Focus filter to a Focus in the Settings app. NFC needs no setup; Settings has a "Scan Tag" button. `hobwork://nfc/<tag>` and, with Associated Domains, `https://<host>/nfc/<tag>` report the tag as scanned.

A command arrives over the socket, by a command push the notification service extension runs, or by a prompt push (NFC) that the app runs when tapped. The command log in the app group makes each command run once and answers repeats with the first result.

Unit tests cover argument checks, command dedup and expiry, result, event and sample encoding, Screen Time intervals and the monitor's actions, alarm schedules, NFC links and records, and the notification summaries. What only a device can show:

- Screen Time: the Family Controls prompt, the app picker, shields from ManagedSettings, and that DeviceActivity calls the monitor extension at interval start, end and threshold (limits, schedules, the end of timed blocks).
- Commands run by the notification service extension: whether ManagedSettings, DeviceActivity, AlarmKit and HealthKit calls work from it at runtime, how long they take against the 30 second limit, and that the summary replaces the text.
- AlarmKit alarms and timers ringing, and the timer's Live Activity.
- NFC reading and writing (the simulator has no NFC), universal links, and iOS background tag reading.
- Health: authorization, queries while locked (`locked`) and background delivery waking the app.
- The Focus filter running when a Focus turns on and off.

## Push in the simulator

The simulator takes pushes from a file, without APNs:

```sh
just push                     # push/actions.apns to the booted simulator
just push path/to/other.apns
```

`push/actions.apns` has the payload the host sends: title and body in `aps.alert`, `category: "hobwork.<id>"` with `mutable-content: 1`, and `hobwork: { id, project, actions }`. Long-press the notification to see the actions. `push/timer.apns` is a command push (the extension runs it once the app is paired) and `push/nfc.apns` a prompt push for an NFC read that runs when tapped. Tapping one sends `{ capability: "notifications", name: "action", data: { id, action } }` to the host, over the socket when connected and with `POST /api/devices/events` otherwise. Tapping the notification itself opens the project in the app.

For real pushes the host needs an APNs key (`HOBWORK_APNS_KEY_FILE`, `HOBWORK_APNS_KEY_ID`, `HOBWORK_APNS_TEAM_ID`). Debug builds register with the sandbox environment, release builds with production.
