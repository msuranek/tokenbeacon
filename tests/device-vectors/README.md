# Device protocol test vectors

Shared by the TokenBeacon tests (`tests/device-protocol.test.ts`) and the
display firmware, so both sides apply the same rules of
[`device-state/v1`](../../docs/device-protocol.md). All data is fictional.

| File | Contents |
| --- | --- |
| `state-cases.json` | Snapshot parts at a fixed time and the exact `state` line TokenBeacon must send. |
| `host-to-device.jsonl` | Lines a device receives and what it must do: `"ok"` or the error code it reports. |
| `device-to-host.jsonl` | Lines TokenBeacon receives from a device and the expected result. |
| `title-host-to-device.jsonl` | `ctx.title` rules (P-037) for devices that announce the `title` capability. Receivers without it ignore the field, so these are not in `host-to-device.jsonl`. |

Each `.jsonl` line is `{"line": "<raw line incl. newline>", "expect": "ok" | "<error code>", "note": "…"}`.
Change a vector only together with the specification.
