// One-button control (GPIO14): short press = next screen, long press = rotate.
// Portable and host-tested. Works across millis() wraparound.
#pragma once

#include <stdint.h>

namespace tb {

class Button {
 public:
  enum class Event : uint8_t { None, Short, Long };

  static constexpr uint32_t kDebounceMs = 30;
  /** A press up to this long is a short press. */
  static constexpr uint32_t kShortMaxMs = 700;
  /** Held this long: long press, reported once while still held. 700–1000 ms does nothing. */
  static constexpr uint32_t kLongMs = 1000;

  /** Feed the raw pin state (true = pressed) on every loop; returns at most one event. */
  Event update(bool rawDown, uint32_t nowMs) {
    if (rawDown != raw_) {
      raw_ = rawDown;
      rawSinceMs_ = nowMs;
    }
    if (raw_ != stable_ && nowMs - rawSinceMs_ >= kDebounceMs) {
      stable_ = raw_;
      if (stable_) {
        pressedAtMs_ = rawSinceMs_;
        longFired_ = false;
      } else {
        const uint32_t held = rawSinceMs_ - pressedAtMs_;
        if (!longFired_ && held <= kShortMaxMs) return Event::Short;
      }
    }
    if (stable_ && !longFired_ && nowMs - pressedAtMs_ >= kLongMs) {
      longFired_ = true;  // once per press, however long it is held
      return Event::Long;
    }
    return Event::None;
  }

 private:
  bool raw_ = false;
  bool stable_ = false;
  bool longFired_ = false;
  uint32_t rawSinceMs_ = 0;
  uint32_t pressedAtMs_ = 0;
};

/** Saves a setting only after it has been left unchanged for `delayMs` (spares the flash). */
class DeferredWrite {
 public:
  explicit DeferredWrite(uint32_t delayMs) : delayMs_(delayMs) {}
  void changed(uint32_t nowMs) {
    pending_ = true;
    changedAtMs_ = nowMs;
  }
  /** True once when the write is due. */
  bool due(uint32_t nowMs) {
    if (!pending_ || nowMs - changedAtMs_ < delayMs_) return false;
    pending_ = false;
    return true;
  }
  bool pending() const { return pending_; }

 private:
  uint32_t delayMs_;
  bool pending_ = false;
  uint32_t changedAtMs_ = 0;
};

}  // namespace tb
