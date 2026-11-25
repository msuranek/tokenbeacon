# TokenBeacon USB display protocol (`device-state/v1`)

Status: **draft** for the optional USB display (planned for v0.3.0). TokenBeacon
sends these messages only when `TOKENBEACON_DEVICE` is set; the display
firmware is not released yet.

TokenBeacon can drive a small display board (reference: LILYGO T-Display-S3)
over a single USB-C cable. The board is a USB CDC serial device; the protocol
is plain text, one JSON object per line.

- Encoder and parsers: [`src/device/protocol.ts`](../src/device/protocol.ts)
- JSON Schema: [`device-protocol.schema.json`](device-protocol.schema.json)
- Test vectors shared by TokenBeacon and the firmware:
  [`tests/device-vectors/`](../tests/device-vectors/)

## Principles

- **Display data only.** Messages carry the remaining 5-hour and weekly limit,
  the context usage of the most recently active thread, whether each value is
  *current*, *last known* or *unavailable*, and how old it is. They never carry
  project names, thread IDs, prompts, conversation content, file paths, token
  counts, model names or credentials. The name of the thread whose context is
  shown is sent only if the user turns it on and the device asks for it (see
  [Thread title](#thread-title-optional)).
- **No estimates.** A value TokenBeacon does not have is sent as
  `{"st":"unavailable"}` and the display shows `N/A`.
- **No clock on the device.** Times are sent as ages and countdowns in whole
  seconds at the moment of sending; the device adds its own elapsed time.
- **One direction for data.** The host sends state; the device only answers
  the handshake, reports that it is alive, and reports errors. The device has
  no access to Codex data, files or the TokenBeacon API.
- **Untrusted input both ways.** Each side bounds the line length, accepts only
  known message types and ignores unknown fields.

## Framing

- UTF-8, one JSON object per line, terminated by `\n` (`\r\n` is accepted).
- At most **512 bytes** per line including the newline. Longer lines are
  rejected (`line_too_long`).
- `tb` is the protocol major version (`1`). A different integer is rejected
  with `unsupported_version`.
- `t` is the message type.
- Receivers ignore unknown fields, so later minor versions can add fields.

## Messages from TokenBeacon (host)

### `hello`

Sent after opening the port. The device must answer with its own `hello`
echoing the same `nonce` within 2 seconds, or the host closes the port.

```json
{"tb":1,"t":"hello","host":"tokenbeacon","ver":"0.3.0","nonce":"5f1c9a2e"}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `host` | `"tokenbeacon"` | Sender identity. |
| `ver` | string, `[0-9A-Za-z.+-]{1,32}` | TokenBeacon version. |
| `nonce` | lowercase hex, 8–32 chars | Random value the device must echo. |

### `state`

Sent when the displayed data changes, and at least every `next` seconds
(10 s) as a heartbeat. At most one message per second.

```json
{"tb":1,"t":"state","seq":128,"five":{"st":"last-known","left":58,"win":"active","reset":7920,"age":312},"week":{"st":"unavailable"},"ctx":{"st":"current","used":46,"age":4},"next":10}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `seq` | integer 0 – 2³¹−1 | Message counter; wraps to 0. |
| `five` | limit | 5-hour limit. |
| `week` | limit | Weekly limit. |
| `ctx` | context | Context window of the most recently active thread. |
| `next` | integer 1 – 60 | The next message arrives within this many seconds. |

**Limit** – one of:

| Shape | Meaning | Display |
| --- | --- | --- |
| `{"st":"unavailable"}` | No limit data. | `N/A` |
| `{"st":…,"win":"expired","age":…}` | The window has ended and Codex has not recorded the new one yet. Never carries a percentage. | “Awaiting fresh data” |
| `{"st":…,"left":…,"win":"active","reset":…,"age":…}` | Active window. | Percentage left |

- `st`: `current` or `last-known` (limits are normally `last-known`: Codex
  records them only while it is used).
- `left`: whole percent of the limit left, 0–100.
- `reset`: seconds until the window resets; omitted when unknown.
- `age`: seconds since Codex recorded the value; omitted when unknown.

**Context** – `{"st":"unavailable"}`, or
`{"st":"current"|"last-known","used":0–100,"age":…}` with `used` the whole
percent of the context window in use, and optionally `title` (see below).

#### Thread title (optional)

`ctx.title` is the name of the thread the context value belongs to – always the
same thread, never another one – as the TokenBeacon dashboard shows it.

- Sent only when the user sets `TOKENBEACON_DEVICE_TITLE=on` on the host (off by
  default) **and** the device listed `"title"` in `caps` in its `hello` on the
  current connection. After every reconnect the device must announce it again.
- 1–200 UTF-8 bytes, no control characters, well-formed UTF-8. Longer titles are
  cut by the host between whole characters and end with `...`. The text is
  otherwise unchanged (diacritics, paths and addresses included).
- Not sent when `ctx` is `unavailable`. When the user turns the feature off, the
  next `state` has no `title`.
- A device shows the title only while the data is fresh, removes it when a
  `state` arrives without it, on a new `hello`, when the host disconnects and
  when the data becomes stale, and never stores it.
- A device without the capability never receives it; if it did, it would ignore
  the unknown field. Title rules for capable devices are in
  `tests/device-vectors/title-host-to-device.jsonl`.

## Messages from the device

### `hello`

```json
{"tb":1,"t":"hello","dev":"tokenbeacon-display","fw":"0.1.0","proto":[1],"nonce":"5f1c9a2e","id":"c3a9f01b"}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `dev` | `"tokenbeacon-display"` | Device identity; anything else is `unknown_device`. |
| `fw` | string, `[0-9A-Za-z.+-]{1,32}` | Firmware version. |
| `proto` | 1–8 integers 1–255 | Supported protocol major versions. |
| `caps` | optional, 0–8 strings `[a-z0-9_]{1,16}` | Optional features the device supports, e.g. `["title"]`. Unknown names are ignored. |
| `nonce` | lowercase hex, 8–32 chars | The host's nonce, echoed. |
| `id` | lowercase hex, 4–32 chars | Device ID derived from the chip (not the raw MAC address). |

### `alive`

Sent every 10 seconds. `seq` is the last state `seq` the device applied, `up`
its uptime in seconds.

```json
{"tb":1,"t":"alive","seq":128,"up":3605}
```

### `err`

Reports a rejected host line by code only, e.g. `line_too_long`, `bad_json`,
`unsupported_version`, `unknown_type`, `bad_field`.

```json
{"tb":1,"t":"err","code":"bad_field"}
```

## Host behaviour (TokenBeacon)

Off unless `TOKENBEACON_DEVICE` is set:

| Setting | Behaviour |
| --- | --- |
| unset or `off` | No device code runs. |
| `auto` | Uses a port that identifies as a TokenBeacon display: USB vendor ID `0x303A` (Espressif) and product name `TokenBeacon Display`. `TOKENBEACON_DEVICE_SERIAL` limits this to one USB serial number. |
| `COM5`, `/dev/cu.usbmodem1101` | Uses exactly this port. |

- **Discovery** every 5 seconds while no display is connected: `ioreg` on
  macOS; on Windows a built-in Windows PowerShell 5.1 helper with a fixed
  script (`System.IO.Ports`), started only when the display is enabled.
- **Handshake:** after opening the port the host sends `hello`; a port that
  does not answer with a matching `hello` within 2 seconds, or answers as
  another device, is closed and not tried again until TokenBeacon restarts.
  Exception: a display that already completed a handshake in this run and
  only stays silent (no answer at all) is tried again after 5, 15, 30 and
  then every 60 seconds. A wrong identity, nonce or protocol version is never
  retried.
- **Sending:** a `state` message right after the handshake, then when the
  displayed values change and at least every 10 seconds; never more than one
  per second.
- **Watchdog:** no `alive` or `err` line from the device for 30 seconds
  closes the port; unplugging is detected and the display is found again.
  Closing releases the port completely, so the display sees it open again.
  The log names the reason as a code (`disconnected`, `device_silent`,
  `write_failed`), never port names or data.
- **Busy port** (another program, such as a serial monitor, holds it): retried
  after 15, 30 and then every 60 seconds; other programs are never stopped.
- **Port settings:** DTR on, RTS off, never 1200 baud, so the board neither
  resets nor enters its bootloader.
- **Status:** `/api/health` gains a `device` entry (`searching`, `handshake`,
  `connected`, `busy`, `unrecognized` and a detail code) only when the display
  is enabled. It never changes the overall status.

## Timing on the device

- No state for more than 30 seconds: show the data as stale.
- No state for more than 120 seconds: show “No connection”; keep the last
  values dimmed with their age, never new estimates.
- Ages and countdowns advance with the device's own monotonic clock between
  messages.

## Error codes

| Code | Meaning |
| --- | --- |
| `line_too_long` | Line over 512 bytes. |
| `bad_json` | Not a JSON object. |
| `unsupported_version` | `tb` is an integer other than 1. |
| `unknown_type` | `t` is not a known message type. |
| `unknown_device` | Device `hello` with another `dev` value. |
| `bad_field` | A required field is missing or out of range. |
