# TokenBeacon display firmware (preview)

Firmware for an optional desk display that shows TokenBeacon's 5-hour limit,
weekly limit and the context of the active Codex thread. It talks to
TokenBeacon over a single USB-C cable using the
[`device-state/v1`](../docs/device-protocol.md) protocol.

> **Preview.** The firmware builds and its protocol logic is tested, but it
> has not been verified on a real board yet. Do not rely on it.

- Reference board: **LILYGO T-Display-S3** (ESP32-S3, 16 MB flash, 8 MB PSRAM,
  1.9" ST7789 170 × 320 display). The touch version is not needed.
- No Wi-Fi, no Bluetooth, no network: the firmware never starts them.
- Shows only what TokenBeacon sends; missing values are shown as `N/A`.

## Build and test

Requires [PlatformIO Core](https://platformio.org/) 6.1.18 (or the PlatformIO
extension for VS Code). Versions are pinned in `platformio.ini`:
`espressif32@6.5.0` (Arduino-ESP32 2.0.14), TFT_eSPI 2.5.43 and
ArduinoJson 7.4.2. Newer Arduino-ESP32 versions are not supported by this
TFT_eSPI setup.

```sh
cd firmware
pio test -e native      # protocol, model and formatting tests on your computer
pio run -e tdisplay_s3  # build the firmware
```

The host tests use the same protocol vectors as TokenBeacon
(`tests/device-vectors`), so both sides follow the same rules.

## Flash

```sh
pio run -e tdisplay_s3 -t upload
```

The firmware uses the ESP32-S3's own USB (TinyUSB) and reports itself as
**TokenBeacon Display**. If the upload does not start, put the board into
download mode: hold **BOOT**, press and release **RST**, release **BOOT**, then
upload again and press **RST** afterwards.

## Use with TokenBeacon

```sh
TOKENBEACON_DEVICE=auto npm start                      # macOS
$env:TOKENBEACON_DEVICE = "auto"; npm start            # Windows PowerShell
```

The display shows “Waiting for TokenBeacon…” until TokenBeacon connects. The
user button (GPIO14, not BOOT) changes the brightness.

## Layout

| Path | Contents |
| --- | --- |
| `lib/tb_core/` | Portable protocol parser, display model and formatting (host-tested) |
| `src/main.cpp` | USB identity, protocol loop, backlight and button |
| `src/ui.cpp` | The 170 × 320 portrait screen |
| `test/test_core/` | Unity tests with the shared vectors |
| `boards/` | Board definition for PlatformIO |
