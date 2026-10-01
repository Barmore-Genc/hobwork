# Hobwork push relay privacy policy

The Hobwork push relay delivers notifications from your Hobwork server to the Hobwork app through Apple Push Notification service (APNs). Your server never learns your device's push token, and the relay never sees what a notification says: your server encrypts it for your device.

## What the relay keeps

- **Your device's push token** and whether it is for a development or App Store build, so the relay can send pushes to it. It is deleted when you turn notifications off in the app, 30 days after APNs reports the token no longer works, or when another registration on the same device replaces it.
- **The servers you allow to notify you**: for each paired server, a random ID for the pairing, the server's public key and when the permission expires. The relay does not know the server's address. A permission expires 30 days after the app last renewed it and is deleted 30 days after that.
- **An App Attest key**, on devices that support it, so the relay can check that requests come from the real Hobwork app on your device.
- **A request log** kept for 14 days: the time, what was asked, the result, the APNs status, and the registration or permission ID. Your IP address is stored only as a keyed hash, and the key is replaced every 7 days, so requests can be linked to each other within a week but not after, and the address cannot be recovered.

## What the relay does not keep

Notification contents, your server's address, your name, email address or any account, your IP address in readable form.

## What others see

Apple sees the push token, the time and size of each push, and the generic text shown before the app opens it. Anyone who runs the relay can see the same.
