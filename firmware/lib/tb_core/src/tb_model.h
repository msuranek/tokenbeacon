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

/** Freshness tag drawn next to a value. */
enum class Tag : uint8_t { None, Now, Last };

/**
 * NOW only for a value the host marked current while the link is live (at most
 * kStaleAfterMs since the last state); otherwise LAST, so minutes-old data is
 * never labelled NOW. None when there is no value.
 */
constexpr Tag valueTag(ValueState st, Link link) {
  return st == ValueState::Unavailable                      ? Tag::None
         : st == ValueState::Current && link == Link::Live ? Tag::Now
                                                           : Tag::Last;
}

struct FieldView {
  ValueState st = ValueState::Unavailable;
  Window win = Window::None;  // limits only
  int16_t percent = -1;       // left (limits) or used (context); -1 when not shown
  int64_t ageSec = -1;        // -1 when unknown
  int64_t resetSec = -1;      // limits only; -1 when unknown
};

class DisplayModel {
 public:
  /**
   * The host (re)connected: its sequence numbers start again. Values are kept,
   * the thread title is dropped until a state carries it again.
   */
  void onHostHello(uint32_t nowMs);

  /** The host closed the port: the thread title is dropped at once. */
  void onHostGone() { state_.ctx.title[0] = '\0'; }

  /** Applies a state message; returns false for an old or repeated sequence number. */
  bool apply(const StateMessage& message, uint32_t nowMs);

  bool hasState() const { return hasState_; }
  int64_t lastSeq() const { return lastSeq_; }
  Link link(uint32_t nowMs) const;
  FieldView five(uint32_t nowMs) const { return limitView(state_.five, nowMs); }
  FieldView week(uint32_t nowMs) const { return limitView(state_.week, nowMs); }
  FieldView context(uint32_t nowMs) const;
  /**
   * The name of the thread the context belongs to, only while that context is
   * shown with live data (at most kStaleAfterMs old); otherwise nullptr. It
   * always comes from the same state message as the context value.
   */
  const char* title(uint32_t nowMs) const;
  /** Whole seconds since the last state message, or -1 before the first one. */
  int64_t secondsSinceUpdate(uint32_t nowMs) const;

 private:
  FieldView limitView(const LimitValue& value, uint32_t nowMs) const;
  /**
   * Milliseconds since the last state. A `nowMs` taken just before the state
   * arrived (loop() reads the clock, then the USB data) would wrap around to
   * ~49 days and show "No connection" for a frame; such a time counts as 0.
   * Real millis() wraparound (elapsed < 2^31 ms) still works.
   */
  uint32_t elapsedMs(uint32_t nowMs) const {
    const uint32_t since = nowMs - receivedMs_;
    return since > 0x80000000u ? 0 : since;
  }
  int64_t elapsedSec(uint32_t nowMs) const { return static_cast<int64_t>(elapsedMs(nowMs) / 1000u); }

  StateMessage state_;
  bool hasState_ = false;
  bool hasSeq_ = false;
  int64_t lastSeq_ = -1;
  uint32_t receivedMs_ = 0;
};

}  // namespace tb
