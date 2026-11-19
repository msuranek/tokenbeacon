// What the display shows, derived from the last state message and the
// device's own clock (milliseconds since boot). No wall clock is needed:
// ages and countdowns advance from the moment a message arrived.
#pragma once

#include <stdint.h>

#include "tb_protocol.h"

namespace tb {

enum class Link : uint8_t { Waiting, Live, Stale, Offline };

constexpr uint32_t kStaleAfterMs = 30000;
constexpr uint32_t kOfflineAfterMs = 120000;

struct FieldView {
  ValueState st = ValueState::Unavailable;
  Window win = Window::None;  // limits only
  int16_t percent = -1;       // left (limits) or used (context); -1 when not shown
  int64_t ageSec = -1;        // -1 when unknown
  int64_t resetSec = -1;      // limits only; -1 when unknown
};

class DisplayModel {
 public:
  /** The host (re)connected: its sequence numbers start again. Values are kept. */
  void onHostHello(uint32_t nowMs);

  /** Applies a state message; returns false for an old or repeated sequence number. */
  bool apply(const StateMessage& message, uint32_t nowMs);

  bool hasState() const { return hasState_; }
  int64_t lastSeq() const { return lastSeq_; }
  Link link(uint32_t nowMs) const;
  FieldView five(uint32_t nowMs) const { return limitView(state_.five, nowMs); }
  FieldView week(uint32_t nowMs) const { return limitView(state_.week, nowMs); }
  FieldView context(uint32_t nowMs) const;
  /** Whole seconds since the last state message, or -1 before the first one. */
  int64_t secondsSinceUpdate(uint32_t nowMs) const;

 private:
  FieldView limitView(const LimitValue& value, uint32_t nowMs) const;
  int64_t elapsedSec(uint32_t nowMs) const { return static_cast<int64_t>(static_cast<uint32_t>(nowMs - receivedMs_) / 1000u); }

  StateMessage state_;
  bool hasState_ = false;
  bool hasSeq_ = false;
  int64_t lastSeq_ = -1;
  uint32_t receivedMs_ = 0;
};

}  // namespace tb
