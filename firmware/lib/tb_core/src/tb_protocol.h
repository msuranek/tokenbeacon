// device-state/v1 for the TokenBeacon display: parsing host lines and
// building device lines. Portable C++ (no Arduino), tested on the host with
// the shared vectors in tests/device-vectors. Spec: docs/device-protocol.md.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "tb_text.h"

namespace tb {

constexpr size_t kMaxLineBytes = 512;
constexpr int64_t kMaxCount = 2147483647;
constexpr const char* kDeviceName = "tokenbeacon-display";

enum class ParseError : uint8_t { None, LineTooLong, BadJson, UnsupportedVersion, UnknownType, BadField };

/** Stable code as used in `err` messages and the test vectors ("ok" for None). */
const char* errorCode(ParseError error);

enum class ValueState : uint8_t { Unavailable, Current, LastKnown };
enum class Window : uint8_t { None, Active, Expired };

struct LimitValue {
  ValueState st = ValueState::Unavailable;
  Window win = Window::None;
  int16_t left = -1;   // 0-100 when win == Active
  int64_t reset = -1;  // seconds, -1 when unknown
  int64_t age = -1;    // seconds, -1 when unknown
};

struct ContextValue {
  ValueState st = ValueState::Unavailable;
  int16_t used = -1;  // 0-100 when available
  int64_t age = -1;
  /** Optional name of the thread this context belongs to (P-037); empty when not sent. */
  char title[kMaxTitleBytes + 1] = {0};
};

struct StateMessage {
  int64_t seq = 0;
  LimitValue five;
  LimitValue week;
  ContextValue ctx;
  int16_t next = 10;
};

struct HostHello {
  char ver[33] = {0};
  char nonce[33] = {0};
};

enum class HostMessageType : uint8_t { Hello, State };

struct HostMessage {
  HostMessageType type = HostMessageType::State;
  HostHello hello;
  StateMessage state;
};

/**
 * Parses one host line (including its newline) with the rules every device
 * applies: at most kMaxLineBytes bytes, a JSON object, tb == 1, a known type,
 * valid fields. Unknown fields are ignored.
 */
ParseError parseHostLine(const char* line, size_t length, HostMessage& out);

/**
 * Device lines, each ending in "\n". Return the length, or 0 if `capacity` is too small.
 * The hello announces the "title" capability (P-037).
 */
size_t buildHello(char* out, size_t capacity, const char* nonce, const char* firmware, const char* deviceId);
size_t buildAlive(char* out, size_t capacity, int64_t seq, uint32_t uptimeSeconds);
size_t buildError(char* out, size_t capacity, ParseError error);

/** 8 lowercase hex digits derived from the chip's MAC address (the raw MAC is never sent). */
void deviceIdFromMac(uint64_t mac, char out[9]);

}  // namespace tb
