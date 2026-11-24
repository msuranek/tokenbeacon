// Outgoing lines for USB, sent in pieces that fit the CDC transmit buffer.
//
// The ESP32-S3 TinyUSB CDC transmit FIFO holds only 64 bytes, so a longer line
// (the hello answer is about 120 bytes) could never be written in one go, and
// USBCDC::write() would spin while the host does not read. Lines are queued
// here and drained a piece at a time from loop(); nothing ever blocks. If the
// host stops reading and the queue is full, new lines are dropped (the host
// treats a silent device as gone and reconnects).
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace tb {

class TxQueue {
 public:
  static constexpr size_t kCapacity = 512;

  /** Queues a whole line; false (nothing queued) if it does not fit. */
  bool push(const char* line, size_t length) {
    if (length == 0 || length > kCapacity) return false;
    compact();
    if (length_ + length > kCapacity) return false;
    memcpy(data_ + length_, line, length);
    length_ += length;
    return true;
  }

  /** The next bytes to send: at most `space` bytes. */
  size_t peek(size_t space, const char** out) const {
    *out = data_ + start_;
    const size_t pending = length_ - start_;
    return pending < space ? pending : space;
  }

  /** Marks `count` bytes as sent. */
  void consume(size_t count) {
    start_ += count < length_ - start_ ? count : length_ - start_;
    if (start_ == length_) start_ = length_ = 0;
  }

  size_t pending() const { return length_ - start_; }
  void clear() { start_ = length_ = 0; }

 private:
  void compact() {
    if (start_ == 0) return;
    memmove(data_, data_ + start_, length_ - start_);
    length_ -= start_;
    start_ = 0;
  }

  char data_[kCapacity] = {0};
  size_t start_ = 0;
  size_t length_ = 0;
};

}  // namespace tb
