# Device protocol test vectors

Shared by the TokenBeacon tests (`tests/device-protocol.test.ts`) and the
display firmware, so both sides apply the same rules of
[`device-state/v1`](../../docs/device-protocol.md). All data is fictional.

| File | Contents |
| --- | --- |
| `state-cases.json` | Snapshot parts at a fixed time and the exact `state` line TokenBeacon must send. |
| `host-to-device.jsonl` | Lines a device receives and what it must do: `"ok"` or the error code it reports. |
| `device-to-host.jsonl` | Lines TokenBeacon receives from a device and the expected result. |

Each `.jsonl` line is `{"line": "<raw line incl. newline>", "expect": "ok" | "<error code>", "note": "…"}`.
Change a vector only together with the specification.
