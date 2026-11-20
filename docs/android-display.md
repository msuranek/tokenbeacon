# Android phone as a Bluetooth display (preview, macOS)

An old Android phone can show your Codex limits next to your Mac, without a
cable. The phone runs the TokenBeacon Display app; TokenBeacon on the Mac sends
it the same small data as the USB display: the 5-hour and weekly limits, the
context of the most recent thread, and how fresh each value is. No names,
paths, prompts or token counts leave the Mac, and nothing uses the internet.

## Requirements

- macOS 13 or newer with Bluetooth, and the Xcode Command Line Tools
  (`xcode-select --install`), needed once to build a small Bluetooth helper.
- An Android phone with Bluetooth Low Energy and Android 8 or newer that can
  advertise as a Bluetooth peripheral (most phones can; the app tells you if
  yours cannot). Tested with a Xiaomi Redmi 8 (Android 10, MIUI 12.5).
- To build the app: the Android SDK command-line tools and a JDK 17 or newer
  (Android Studio includes both). No Gradle and no downloads during the build.

## 1. Build and install the app

```sh
android/build.sh
```

This runs the app's protocol tests and writes
`android/build/tokenbeacon-display.apk`, signed with a local debug key.

Install it with USB debugging enabled on the phone:

```sh
adb install android/build/tokenbeacon-display.apk
```

On Xiaomi phones (MIUI), `adb install` can fail with
`INSTALL_FAILED_USER_RESTRICTED` even with “Install via USB” turned on. Copy
the file instead and install it from the phone's file manager:

```sh
adb push android/build/tokenbeacon-display.apk /sdcard/Download/
```

The app asks for no internet, location or storage access.

## 2. Pair the phone

Open the app; it shows “Waiting for TokenBeacon…” and its **display ID** at
the bottom (16 characters, e.g. `1a2b 3c4d 5e6f 7a8b`). On the Mac:

```sh
npm run ble:pair
```

- macOS asks once whether **TokenBeacon BLE** may use Bluetooth: allow it.
- macOS and the phone may ask to pair: check that both show the same number
  and confirm.
- Type the display ID shown on the phone. Only the phone with exactly this ID
  is paired.

TokenBeacon never pairs a phone on its own. To pair a different phone, run
`npm run ble:unpair` first.

## 3. Start TokenBeacon with the Bluetooth display

```sh
TOKENBEACON_DEVICE=ble npm start
```

The phone shows “Connected · live” within a few seconds. If the link drops
(phone restarted, out of range, Bluetooth off), TokenBeacon reconnects on its
own; the phone proves its identity again every time. `/api/health` reports the
display state in its `device` entry; Bluetooth problems never affect the
dashboard.

Optional: `TOKENBEACON_DEVICE_ID=<display ID>` makes TokenBeacon use only that
phone. It selects a phone; it is not a password.

## Display settings (Settings button in the app)

| Setting | What it does |
| --- | --- |
| **Auto** (default) | Desk while the phone is charging, Portable on battery. |
| **Desk** | For a phone on a charger: the screen can stay on and the phone advertises often, so reconnects are quick. |
| **Portable** | Saves battery: the system screen timeout applies, brightness is at most 40 % and the phone advertises less often (reconnects take a little longer). |
| **Always-on screen** | In Desk mode, keeps the screen on. Against burn-in, the content moves by a few pixels every minute and the screen dims when there is no fresh data. |
| **Brightness** | The app's own brightness, or follow the system. Does not change system settings. |
| **Battery protection** | On battery: saves power at 20 %, pauses Bluetooth at 10 % and resumes above 15 % or on the charger. Dims the screen when the phone is warm. |
| **Require Bluetooth pairing** | On by default. Turn off only to diagnose connection problems: without it the link is not encrypted. |

Android does not let apps stop charging without root. For a phone that stays
on a charger, use the phone's own battery protection if it has one, or a
smart plug or timer. MIUI may stop apps in the background: if the display
disconnects when the screen is off, set the app's battery saver to “No
restrictions”.

## Security

- The Mac only connects out to a phone advertising the TokenBeacon service. It
  does not advertise and accepts no Bluetooth connections.
- The phone requires an encrypted, authenticated Bluetooth link and keeps an
  ECDSA P-256 key in the Android Keystore. On every connection it signs a fresh
  random challenge. TokenBeacon stores only the public key of the phone you
  paired (`~/Library/Application Support/TokenBeacon`, readable only by you).
- The Bluetooth helper is built on your Mac from the source in
  `src/device/ble-helper/` into `~/Library/Caches/TokenBeacon`, only when its
  source changes, and macOS gives Bluetooth access to the helper alone.

See [SECURITY.md](../SECURITY.md) and [the protocol](device-protocol.md).

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `npm run ble:pair` finds no phone | Keep the app open on the phone with Bluetooth on; move the phone closer. |
| Health shows `not_paired` | Run `npm run ble:pair`. |
| Health shows `bluetooth_unauthorized` | Allow TokenBeacon BLE in System Settings → Privacy & Security → Bluetooth. |
| Health shows `helper_unavailable` | Install the Xcode Command Line Tools, then restart TokenBeacon. |
| Health shows `untrusted` | Another phone answered; only the paired phone is used. To switch phones: `npm run ble:unpair`, then `npm run ble:pair`. |
| The phone shows “Paused · low battery” | Connect the charger. |
| macOS asks for Bluetooth access again after an update | Expected: the helper was rebuilt from changed source. |
