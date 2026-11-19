#include "ui.h"

#include <stdio.h>

#include "tb_format.h"

namespace ui {
namespace {

constexpr int kWidth = 170;
constexpr int kHeight = 320;
constexpr int kStatusHeight = 22;
constexpr int kBlockHeight = 99;
constexpr int kMargin = 10;

// RGB565 palette (dark background, readable on an IPS panel).
constexpr uint16_t kBackground = 0x0841;
constexpr uint16_t kDivider = 0x2124;
constexpr uint16_t kText = 0xFFFF;
constexpr uint16_t kMuted = 0x8C71;
constexpr uint16_t kFaint = 0x4A49;
constexpr uint16_t kTrack = 0x2945;
constexpr uint16_t kOk = 0x2E8B;
constexpr uint16_t kWarn = 0xFD20;
constexpr uint16_t kCritical = 0xF8A6;
constexpr uint16_t kAccent = 0x7C5F;

TFT_eSprite* frame = nullptr;

uint16_t levelColor(tb::Level level) {
  switch (level) {
    case tb::Level::Ok: return kOk;
    case tb::Level::Warn: return kWarn;
    case tb::Level::Critical: return kCritical;
  }
  return kMuted;
}

void drawTag(TFT_eSprite& s, int y, const char* tag, uint16_t color) {
  s.setTextFont(1);
  s.setTextSize(1);
  s.setTextColor(color, kBackground);
  s.setTextDatum(TR_DATUM);
  s.drawString(tag, kWidth - kMargin, y);
}

/** One block: label, big number (or N/A / WAIT), bar and a small note. */
void drawBlock(TFT_eSprite& s, int top, const char* label, const tb::FieldView& view, bool isContext, bool dim) {
  s.drawFastHLine(0, top, kWidth, kDivider);
  s.setTextFont(2);
  s.setTextSize(1);
  s.setTextDatum(TL_DATUM);
  s.setTextColor(kMuted, kBackground);
  s.drawString(label, kMargin, top + 6);

  const bool available = view.st != tb::ValueState::Unavailable;
  if (available) {
    drawTag(s, top + 9, view.st == tb::ValueState::Current ? "NOW" : "LAST", view.st == tb::ValueState::Current ? kOk : kWarn);
  }

  char text[24];
  s.setTextDatum(BL_DATUM);
  if (!available) {
    s.setFreeFont(&FreeSansBold18pt7b);
    s.setTextColor(kFaint, kBackground);
    s.drawString("N/A", kMargin, top + 68);
  } else if (!isContext && view.win == tb::Window::Expired) {
    s.setFreeFont(&FreeSansBold18pt7b);
    s.setTextColor(kWarn, kBackground);
    s.drawString("WAIT", kMargin, top + 68);
    s.setTextFont(2);
    s.setTextColor(kMuted, kBackground);
    s.drawString("window ended", kMargin, top + 92);
    return;
  } else {
    snprintf(text, sizeof(text), "%d%%", view.percent);
    s.setFreeFont(&FreeSansBold24pt7b);
    s.setTextColor(dim ? kMuted : kText, kBackground);
    const int numberWidth = s.drawString(text, kMargin, top + 70);
    s.setTextFont(2);
    s.setTextColor(kMuted, kBackground);
    s.drawString(isContext ? "used" : "left", kMargin + numberWidth + 6, top + 66);
  }

  // Bar (only for real values).
  const int barY = top + 76;
  const int barWidth = kWidth - 2 * kMargin;
  s.fillRoundRect(kMargin, barY, barWidth, 6, 3, kTrack);
  if (available && view.percent >= 0) {
    const tb::Level level = isContext ? tb::contextLevel(view.percent) : tb::limitLevel(view.percent);
    const uint16_t color = isContext && level == tb::Level::Ok ? kAccent : levelColor(level);
    const int filled = barWidth * view.percent / 100;
    if (filled > 0) s.fillRoundRect(kMargin, barY, filled, 6, 3, dim ? kFaint : color);
  }

  // Note: reset countdown for limits, age when the value is old.
  text[0] = '\0';
  if (!isContext && view.resetSec >= 0) {
    char duration[16];
    tb::formatDuration(view.resetSec, duration, sizeof(duration));
    snprintf(text, sizeof(text), "resets in %s", duration);
  } else if (view.ageSec >= 3600) {
    char duration[16];
    tb::formatDuration(view.ageSec, duration, sizeof(duration));
    snprintf(text, sizeof(text), "%s old", duration);
  }
  if (text[0]) {
    s.setTextFont(2);
    s.setTextDatum(BL_DATUM);
    s.setTextColor(kMuted, kBackground);
    s.drawString(text, kMargin, top + 97);
  }
}

void drawStatus(TFT_eSprite& s, const tb::DisplayModel& model, uint32_t nowMs, bool hostConnected, const char* firmware) {
  const tb::Link link = model.link(nowMs);
  uint16_t dot = kCritical;
  const char* label = "No connection";
  if (link == tb::Link::Waiting) {
    dot = hostConnected ? kWarn : kFaint;
    label = hostConnected ? "Connected" : "Waiting";
  } else if (link == tb::Link::Live) {
    dot = kOk;
    label = "USB";
  } else if (link == tb::Link::Stale) {
    dot = kWarn;
    label = "Stale";
  }
  s.fillCircle(kMargin + 4, 11, 4, dot);
  char text[32];
  const int64_t since = model.secondsSinceUpdate(nowMs);
  if (link == tb::Link::Live || since < 0) {
    snprintf(text, sizeof(text), "%s", label);
  } else {
    char duration[16];
    tb::formatDuration(since, duration, sizeof(duration));
    snprintf(text, sizeof(text), "%s %s", label, duration);
  }
  s.setTextFont(2);
  s.setTextDatum(ML_DATUM);
  s.setTextColor(kText, kBackground);
  s.drawString(text, kMargin + 14, 11);
  snprintf(text, sizeof(text), "fw %s", firmware);
  s.setTextFont(1);
  s.setTextDatum(MR_DATUM);
  s.setTextColor(kFaint, kBackground);
  s.drawString(text, kWidth - kMargin, 11);
}

void drawWaiting(TFT_eSprite& s, bool hostConnected) {
  s.setTextDatum(MC_DATUM);
  s.setFreeFont(&FreeSansBold12pt7b);
  s.setTextColor(kText, kBackground);
  s.drawString("TokenBeacon", kWidth / 2, kHeight / 2 - 20);
  s.setTextFont(2);
  s.setTextColor(kMuted, kBackground);
  s.drawString(hostConnected ? "Connected, waiting" : "Waiting for", kWidth / 2, kHeight / 2 + 10);
  s.drawString(hostConnected ? "for data..." : "TokenBeacon...", kWidth / 2, kHeight / 2 + 28);
}

}  // namespace

void begin(TFT_eSPI& tft) {
  tft.fillScreen(kBackground);
  static TFT_eSprite sprite(&tft);
  sprite.setColorDepth(16);
  if (sprite.createSprite(kWidth, kHeight) != nullptr) frame = &sprite;
}

void render(TFT_eSPI& tft, const tb::DisplayModel& model, uint32_t nowMs, bool hostConnected, const char* firmware) {
  if (frame == nullptr) return;  // no memory for the frame buffer: keep the last screen
  TFT_eSprite& s = *frame;
  s.fillSprite(kBackground);
  drawStatus(s, model, nowMs, hostConnected, firmware);
  if (!model.hasState()) {
    drawWaiting(s, hostConnected);
  } else {
    const bool dim = model.link(nowMs) == tb::Link::Offline;
    drawBlock(s, kStatusHeight, "5H LIMIT", model.five(nowMs), false, dim);
    drawBlock(s, kStatusHeight + kBlockHeight, "WEEKLY", model.week(nowMs), false, dim);
    drawBlock(s, kStatusHeight + 2 * kBlockHeight, "CONTEXT", model.context(nowMs), true, dim);
  }
  s.pushSprite(0, 0);
}

}  // namespace ui
