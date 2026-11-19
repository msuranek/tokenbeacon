#include "tb_model.h"

namespace tb {

void DisplayModel::onHostHello(uint32_t) { hasSeq_ = false; }

bool DisplayModel::apply(const StateMessage& message, uint32_t nowMs) {
  if (hasSeq_) {
    // Newer if ahead by less than half the 31-bit range (handles wrap-around to 0).
    const int64_t ahead = (message.seq - lastSeq_ + (kMaxCount + 1)) % (kMaxCount + 1);
    if (ahead == 0 || ahead > (kMaxCount + 1) / 2) return false;
  }
  state_ = message;
  hasState_ = true;
  hasSeq_ = true;
  lastSeq_ = message.seq;
  receivedMs_ = nowMs;
  return true;
}

Link DisplayModel::link(uint32_t nowMs) const {
  if (!hasState_) return Link::Waiting;
  const uint32_t since = nowMs - receivedMs_;
  if (since <= kStaleAfterMs) return Link::Live;
  if (since <= kOfflineAfterMs) return Link::Stale;
  return Link::Offline;
}

int64_t DisplayModel::secondsSinceUpdate(uint32_t nowMs) const { return hasState_ ? elapsedSec(nowMs) : -1; }

FieldView DisplayModel::limitView(const LimitValue& value, uint32_t nowMs) const {
  FieldView view;
  if (!hasState_ || value.st == ValueState::Unavailable) return view;
  const int64_t elapsed = elapsedSec(nowMs);
  view.st = value.st;
  view.win = value.win;
  if (value.age >= 0) view.ageSec = value.age + elapsed;
  if (value.win == Window::Active) {
    view.percent = value.left;
    if (value.reset >= 0) view.resetSec = value.reset > elapsed ? value.reset - elapsed : 0;
  }
  return view;
}

FieldView DisplayModel::context(uint32_t nowMs) const {
  FieldView view;
  const ContextValue& value = state_.ctx;
  if (!hasState_ || value.st == ValueState::Unavailable) return view;
  view.st = value.st;
  view.percent = value.used;
  if (value.age >= 0) view.ageSec = value.age + elapsedSec(nowMs);
  return view;
}

}  // namespace tb
