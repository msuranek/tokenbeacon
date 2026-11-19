// Collects bytes from USB into lines of at most kMaxLineBytes (incl. "\n").
// A longer line is dropped while it arrives – memory stays fixed – and
// reported once, after its newline.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "tb_protocol.h"

namespace tb {

class LineBuffer {
 public:
  enum class Event : uint8_t { None, Line, TooLong };

  /** Adds one byte. On Event::Line, line()/length() hold the line including "\n". */
  Event push(uint8_t byte) {
    if (skipping_) {
      if (byte == '\n') {
        skipping_ = false;
        length_ = 0;
        return Event::TooLong;
      }
      return Event::None;
    }
    if (complete_) {
      complete_ = false;
      length_ = 0;
    }
    if (length_ >= kMaxLineBytes) {
      skipping_ = (byte != '\n');
      length_ = 0;
      return skipping_ ? Event::None : Event::TooLong;
    }
    data_[length_++] = static_cast<char>(byte);
    if (byte == '\n') {
      complete_ = true;
      data_[length_] = '\0';
      return Event::Line;
    }
    return Event::None;
  }

  const char* line() const { return data_; }
  size_t length() const { return length_; }

 private:
  char data_[kMaxLineBytes + 1] = {0};
  size_t length_ = 0;
  bool skipping_ = false;
  bool complete_ = false;
};

}  // namespace tb
