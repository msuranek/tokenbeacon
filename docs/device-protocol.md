# TokenBeacon USB display protocol (`device-state/v1`)

Status: **draft** for the optional USB display (planned for v0.3.0). Nothing
in TokenBeacon sends these messages yet.

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
  project or thread names, thread IDs, prompts, conversation content, file
  paths, token counts, model names or credentials.
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
percent of the context window in use.

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
