#include "ui.h"

#include <stdio.h>
#include <string.h>

#include "fonts/inter_regular_12.h"
#include "fonts/inter_regular_15.h"
#include "fonts/inter_semibold_14.h"
#include "fonts/inter_semibold_22.h"
#include "fonts/inter_semibold_30.h"
#include "fonts/inter_semibold_44.h"
#include "tb_format.h"
#include "tb_text.h"

namespace ui {
namespace {

constexpr uint16_t rgb(uint8_t r, uint8_t g, uint8_t b) {
  return static_cast<uint16_t>(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

// Dark theme. Metric colours: 5h green, weekly blue, context purple.
constexpr uint16_t kBackground = rgb(10, 13, 18);
constexpr uint16_t kDivider = rgb(34, 40, 50);
constexpr uint16_t kTrack = rgb(36, 42, 54);
constexpr uint16_t kText = rgb(240, 242, 246);
constexpr uint16_t kMuted = rgb(140, 148, 162);
constexpr uint16_t kFaint = rgb(78, 86, 100);
// Tuned on the panel: it shows blue-ish, so green and purple are pushed apart.
constexpr uint16_t kFiveHour = rgb(40, 214, 72);
constexpr uint16_t kWeekly = rgb(50, 120, 255);
constexpr uint16_t kContext = rgb(200, 90, 255);
constexpr uint16_t kLive = rgb(46, 204, 113);
constexpr uint16_t kWarn = rgb(245, 166, 35);
constexpr uint16_t kCritical = rgb(239, 68, 68);

constexpr int kMargin = 8;
constexpr int kHeaderHeight = 26;
constexpr int kDotsHeight = 12;
constexpr int kPortraitRotation = 0;   // USB-C at the bottom (checked on the board)
constexpr int kLandscapeRotation = 1;  // checked on the board

TFT_eSprite* sprite = nullptr;
const uint8_t* loadedFont = nullptr;
int width = 170;
int height = 320;

enum class Font : uint8_t { Small, Text, Label, NumberM, NumberL, NumberXL };

const uint8_t* fontData(Font font) {
  switch (font) {
    case Font::Small: return kFontSmall;
    case Font::Text: return kFontText;
    case Font::Label: return kFontLabel;
    case Font::NumberM: return kFontNumberM;
    case Font::NumberL: return kFontNumberL;
    case Font::NumberXL: return kFontNumberXL;
  }
  return kFontText;
}

void use(TFT_eSprite& s, Font font) {
  const uint8_t* data = fontData(font);
  if (data == loadedFont) return;
  s.loadFont(data);
  // TFT_eSPI only guesses the space; use the width of a digit-sized gap instead.
  s.gFont.spaceWidth = s.gFont.yAdvance / 4 + 1;
  loadedFont = data;
}

// --- Text ------------------------------------------------------------------------

/** Advance of a code point in the loaded font; unsupported glyphs are drawn as '?'. */
int advanceOf(uint32_t cp, void* context) {
  TFT_eSprite& s = *static_cast<TFT_eSprite*>(context);
  if (cp == ' ') return s.gFont.spaceWidth;
  uint16_t index = 0;
  if (cp <= 0xFFFF && s.getUnicodeIndex(static_cast<uint16_t>(cp), &index)) return s.gxAdvance[index];
  if (s.getUnicodeIndex('?', &index)) return s.gxAdvance[index];
  return s.gFont.spaceWidth;
}

/** Copies `length` bytes of UTF-8 into `out`, replacing glyphs the font lacks with '?' and dropping joiners. */
void displayable(TFT_eSprite& s, const char* text, size_t length, bool dots, char* out, size_t capacity) {
  size_t o = 0;
  for (size_t i = 0; i < length && o + 5 < capacity;) {
    uint32_t cp = 0;
    size_t n = tb::utf8Decode(text, length, i, cp);
    if (n == 0) n = 1, cp = '?';
    uint16_t index = 0;
    if (tb::isZeroWidth(cp)) {
      // not drawn
    } else if (cp == ' ' || (cp <= 0xFFFF && s.getUnicodeIndex(static_cast<uint16_t>(cp), &index))) {
      memcpy(out + o, text + i, n);
      o += n;
    } else {
      out[o++] = '?';
    }
    i += n;
  }
  if (dots && o + 3 < capacity) memcpy(out + o, "...", 3), o += 3;
  out[o] = '\0';
}

/** Draws text in at most `maxLines` lines inside `maxWidth`, ending with "..." if cut. Returns the bottom y. */
int drawWrapped(TFT_eSprite& s, const char* text, int x, int y, int maxWidth, size_t maxLines, int lineHeight, uint16_t color) {
  tb::LineSpan lines[6];
  if (maxLines > 6) maxLines = 6;
  const size_t count = tb::layoutText(text, strlen(text), maxWidth, maxLines, advanceOf, &s, lines);
  s.setTextColor(color, kBackground);
  s.setTextDatum(TL_DATUM);
  char buffer[tb::kMaxTitleBytes + 8];
  for (size_t i = 0; i < count; ++i) {
    displayable(s, text + lines[i].start, lines[i].length, lines[i].ellipsis, buffer, sizeof(buffer));
    s.drawString(buffer, x, y + static_cast<int>(i) * lineHeight);
  }
  return y + static_cast<int>(count) * lineHeight;
}

void drawText(TFT_eSprite& s, Font font, const char* text, int x, int y, uint16_t color, uint8_t datum = TL_DATUM) {
  use(s, font);
  s.setTextColor(color, kBackground);
  s.setTextDatum(datum);
  s.drawString(text, x, y);
}

int textWidth(TFT_eSprite& s, Font font, const char* text) {
  use(s, font);
  return s.textWidth(text);
}

/** One line cut to `maxWidth` with "..." if needed (never wraps onto the next line). */
void drawFitted(TFT_eSprite& s, Font font, const char* text, int x, int y, int maxWidth, uint16_t color) {
  use(s, font);
  drawWrapped(s, text, x, y, maxWidth, 1, 0, color);
}

// --- Pieces ------------------------------------------------------------------------

uint16_t linkColor(tb::Link link, bool hostConnected) {
  switch (link) {
    case tb::Link::Live: return kLive;
    case tb::Link::Stale: return kWarn;
    case tb::Link::Offline: return kCritical;
    case tb::Link::Waiting: return hostConnected ? kWarn : kFaint;
  }
  return kFaint;
}

void drawHeader(TFT_eSprite& s, const tb::DisplayModel& model, uint32_t now, const Frame& frame) {
  const tb::Link link = model.link(now);
  char state[24];
  const int64_t since = model.secondsSinceUpdate(now);
  char duration[16];
  tb::formatDuration(since, duration, sizeof(duration));
  switch (link) {
    case tb::Link::Live: snprintf(state, sizeof(state), "LIVE"); break;
    case tb::Link::Stale: snprintf(state, sizeof(state), "STALE %s", duration); break;
    case tb::Link::Offline: snprintf(state, sizeof(state), "OFFLINE %s", duration); break;
    case tb::Link::Waiting: snprintf(state, sizeof(state), frame.hostConnected ? "CONNECTED" : "WAITING"); break;
  }
  const uint16_t color = linkColor(link, frame.hostConnected);
  s.fillSmoothCircle(kMargin + 4, kHeaderHeight / 2, 4, color, kBackground);
  drawText(s, Font::Small, state, width - kMargin, kHeaderHeight / 2 + 1, color, MR_DATUM);
  const int stateWidth = textWidth(s, Font::Small, state);
  if (kMargin + 14 + textWidth(s, Font::Label, "TokenBeacon") + 8 < width - kMargin - stateWidth) {
    drawText(s, Font::Label, "TokenBeacon", kMargin + 14, kHeaderHeight / 2 + 1, kText, ML_DATUM);
  }
  s.drawFastHLine(0, kHeaderHeight, width, kDivider);
}

void drawDots(TFT_eSprite& s, Screen screen) {
  const int y = height - kDotsHeight / 2 - 1;
  const int gap = 10;
  const int x0 = width / 2 - (kScreenCount - 1) * gap / 2;
  for (uint8_t i = 0; i < kScreenCount; ++i) {
    const bool active = static_cast<uint8_t>(screen) == i;
    s.fillSmoothCircle(x0 + i * gap, y, active ? 3 : 2, active ? kText : kFaint, kBackground);
  }
}

void drawBar(TFT_eSprite& s, int x, int y, int w, int h, int percent, uint16_t color) {
  s.fillSmoothRoundRect(x, y, w, h, h / 2, kTrack, kBackground);
  if (percent > 0) {
    const int filled = w * (percent > 100 ? 100 : percent) / 100;
    s.fillSmoothRoundRect(x, y, filled < h ? h : filled, h, h / 2, color, kBackground);
  }
}

/** Draws the tag right-aligned and returns its width (0 if none). */
int drawTag(TFT_eSprite& s, tb::Tag tag, int xRight, int y) {
  if (tag == tb::Tag::None) return 0;
  const char* text = tag == tb::Tag::Now ? "NOW" : "LAST";
  drawText(s, Font::Small, text, xRight, y, tag == tb::Tag::Now ? kLive : kWarn, TR_DATUM);
  return textWidth(s, Font::Small, text);
}

/** Label on the left, tag on the right; the label is cut so they never overlap. */
void drawLabelRow(TFT_eSprite& s, const char* label, tb::Tag tag, int x, int y, int w) {
  const int tagWidth = drawTag(s, tag, x + w, y + 2);
  drawFitted(s, Font::Label, label, x, y, w - (tagWidth ? tagWidth + 6 : 0), kMuted);
}

/** Speech bubble in front of the thread name. */
void drawBubble(TFT_eSprite& s, int x, int y, uint16_t color) {
  s.drawRoundRect(x, y, 13, 10, 3, color);
  s.drawLine(x + 3, y + 9, x + 2, y + 12, color);
  s.drawLine(x + 2, y + 12, x + 6, y + 9, color);
}

/** "2h 14m" left of a reset, or the measured age once it is an hour old. */
void limitNote(const tb::FieldView& v, char* out, size_t capacity) {
  out[0] = '\0';
  char duration[16];
  if (v.win == tb::Window::Expired) {
    snprintf(out, capacity, "window ended");
  } else if (v.resetSec >= 0) {
    tb::formatDuration(v.resetSec, duration, sizeof(duration));
    snprintf(out, capacity, "resets in %s", duration);
  } else if (v.ageSec >= 3600) {
    tb::formatMeasuredAgo(v.ageSec, out, capacity);
  }
}

/** The big value of a field: "63%", "WAIT" or "N/A", with its colour. */
const char* valueText(const tb::FieldView& v, bool isContext, char* buffer, size_t capacity, uint16_t& color, bool dim) {
  if (v.st == tb::ValueState::Unavailable || v.percent < 0) {
    if (!isContext && v.win == tb::Window::Expired && v.st != tb::ValueState::Unavailable) {
      color = kWarn;
      return "WAIT";
    }
    color = kFaint;
    return "N/A";
  }
  const tb::Level level = isContext ? tb::contextLevel(v.percent) : tb::limitLevel(v.percent);
  color = dim ? kMuted : level == tb::Level::Critical ? kCritical : level == tb::Level::Warn ? kWarn : kText;
  snprintf(buffer, capacity, "%d%%", v.percent);
  return buffer;
}

struct Metric {
  const char* label;
  tb::FieldView view;
  bool isContext;
  uint16_t color;
};

/** A compact metric: label + tag, value, unit, bar and a note. */
void drawMetric(TFT_eSprite& s, const Metric& m, tb::Link link, int x, int y, int w, int h, Font numberFont, bool showUnit) {
  const bool dim = link == tb::Link::Offline;
  drawLabelRow(s, m.label, tb::valueTag(m.view.st, link), x, y, w);
  char buffer[12];
  uint16_t color = kText;
  const char* value = valueText(m.view, m.isContext, buffer, sizeof(buffer), color, dim);
  const int valueTop = y + 17;
  drawText(s, numberFont, value, x, valueTop, color);
  const bool number = value == buffer;
  if (showUnit && number) {
    const int numberWidth = textWidth(s, numberFont, value);
    use(s, numberFont);
    const int baseline = valueTop + s.gFont.maxAscent;
    drawText(s, Font::Small, m.isContext ? "used" : "left", x + numberWidth + 4, baseline, kMuted, BL_DATUM);
  }
  use(s, numberFont);
  const int barY = valueTop + s.gFont.maxAscent + 4;
  drawBar(s, x, barY, w, 6, number ? m.view.percent : 0, dim ? kFaint : m.color);
  char note[40];
  if (m.isContext) {
    tb::formatMeasuredAgo(m.view.ageSec, note, sizeof(note));
  } else {
    limitNote(m.view, note, sizeof(note));
  }
  if (note[0] && barY + 9 + 13 <= y + h) drawFitted(s, Font::Small, note, x, barY + 9, w, kMuted);
}

Metric fiveMetric(const tb::DisplayModel& model, uint32_t now) { return {"5h limit", model.five(now), false, kFiveHour}; }
Metric weekMetric(const tb::DisplayModel& model, uint32_t now) {
  return {width < height ? "Weekly limit" : "Weekly", model.week(now), false, kWeekly};
}
Metric contextMetric(const tb::DisplayModel& model, uint32_t now) { return {"Context", model.context(now), true, kContext}; }

void drawWaiting(TFT_eSprite& s, bool hostConnected) {
  const int cy = (kHeaderHeight + height - kDotsHeight) / 2;
  drawText(s, Font::NumberM, "TokenBeacon", width / 2, cy - 14, kText, MC_DATUM);
  drawText(s, Font::Text, hostConnected ? "Connected, waiting for data" : "Waiting for TokenBeacon", width / 2, cy + 14, kMuted,
           MC_DATUM);
}

/** Title block: bubble + up to `lines` lines. */
void drawTitle(TFT_eSprite& s, const char* title, int x, int y, int w, size_t lines) {
  drawBubble(s, x, y + 3, kMuted);
  use(s, Font::Text);
  drawWrapped(s, title, x + 19, y, w - 19, lines, 18, kText);
}

// --- Screens -------------------------------------------------------------------------

void drawOverview(TFT_eSprite& s, const tb::DisplayModel& model, uint32_t now) {
  const tb::Link link = model.link(now);
  const char* title = model.title(now);
  const Metric metrics[3] = {fiveMetric(model, now), weekMetric(model, now), contextMetric(model, now)};
  const int bottom = height - kDotsHeight;
  if (width < height) {
    // Portrait: three metrics stacked, the thread name below.
    const int titleHeight = title ? 44 : 0;
    const int top = kHeaderHeight + 5;
    const int blockHeight = (bottom - titleHeight - top) / 3;
    for (int i = 0; i < 3; ++i) {
      const int y = top + i * blockHeight;
      if (i > 0) s.drawFastHLine(kMargin, y - 4, width - 2 * kMargin, kDivider);
      drawMetric(s, metrics[i], link, kMargin, y, width - 2 * kMargin, blockHeight - 5, Font::NumberL, true);
    }
    if (title) {
      const int y = bottom - titleHeight;
      s.drawFastHLine(kMargin, y, width - 2 * kMargin, kDivider);
      drawTitle(s, title, kMargin, y + 5, width - 2 * kMargin, 2);
    }
    return;
  }
  // Landscape: three metrics side by side, the thread name in the bottom row.
  const int titleHeight = title ? 28 : 0;
  const int top = kHeaderHeight + 6;
  const int columnWidth = width / 3;
  for (int i = 0; i < 3; ++i) {
    const int x = i * columnWidth;
    if (i > 0) s.drawFastVLine(x, top, bottom - titleHeight - top - 6, kDivider);
    drawMetric(s, metrics[i], link, x + kMargin, top, columnWidth - 2 * kMargin, bottom - titleHeight - top, Font::NumberL, false);
  }
  if (title) {
    const int y = bottom - titleHeight;
    s.drawFastHLine(kMargin, y, width - 2 * kMargin, kDivider);
    drawTitle(s, title, kMargin, y + 6, width - 2 * kMargin, 1);
  }
}

void drawRing(TFT_eSprite& s, int cx, int cy, int r, int thickness, const tb::FieldView& v, tb::Link link) {
  const bool dim = link == tb::Link::Offline;
  const bool number = v.st != tb::ValueState::Unavailable && v.percent >= 0;
  // TFT_eSPI angles: 0 at the bottom, clockwise. The ring starts at the top (180).
  s.drawSmoothArc(cx, cy, r, r - thickness, 0, 360, kTrack, kBackground, false);
  if (number && v.percent > 0) {
    const uint32_t end = 180 + static_cast<uint32_t>(v.percent) * 360 / 100;
    const uint16_t color = dim ? kFaint : kFiveHour;
    if (end <= 360) {
      s.drawSmoothArc(cx, cy, r, r - thickness, 180, end, color, kBackground, true);
    } else {
      s.drawSmoothArc(cx, cy, r, r - thickness, 180, 360, color, kBackground, false);
      s.drawSmoothArc(cx, cy, r, r - thickness, 0, end - 360, color, kBackground, true);
    }
  }
  char buffer[12];
  uint16_t color = kText;
  const char* value = valueText(v, false, buffer, sizeof(buffer), color, dim);
  drawText(s, Font::Small, "5h limit", cx, cy - 26, kMuted, MC_DATUM);
  drawText(s, value == buffer ? Font::NumberL : Font::NumberM, value, cx, cy + 2, color, MC_DATUM);
  if (value == buffer) drawText(s, Font::Small, "left", cx, cy + 26, kMuted, MC_DATUM);
}

void drawLimits(TFT_eSprite& s, const tb::DisplayModel& model, uint32_t now) {
  const tb::Link link = model.link(now);
  const tb::FieldView five = model.five(now);
  char note[40];
  limitNote(five, note, sizeof(note));
  const Metric week = weekMetric(model, now);
  if (width < height) {
    const int cy = kHeaderHeight + 76;
    drawRing(s, width / 2, cy, 64, 10, five, link);
    drawTag(s, tb::valueTag(five.st, link), width - kMargin, kHeaderHeight + 6);
    if (note[0]) drawText(s, Font::Small, note, width / 2, cy + 74, kMuted, MC_DATUM);  // short text, fits
    const int y = cy + 92;
    s.drawFastHLine(kMargin, y - 6, width - 2 * kMargin, kDivider);
    drawMetric(s, week, link, kMargin, y, width - 2 * kMargin, height - kDotsHeight - y, Font::NumberL, true);
    return;
  }
  const int cx = 82;
  const int cy = kHeaderHeight + 2 + (height - kDotsHeight - kHeaderHeight) / 2 - 8;
  drawRing(s, cx, cy, 56, 9, five, link);
  if (note[0]) drawText(s, Font::Small, note, cx, cy + 65, kMuted, MC_DATUM);
  drawTag(s, tb::valueTag(five.st, link), 160, kHeaderHeight + 6);
  s.drawFastVLine(168, kHeaderHeight + 8, height - kDotsHeight - kHeaderHeight - 16, kDivider);
  drawMetric(s, week, link, 178, kHeaderHeight + 10, width - 178 - kMargin, height - kDotsHeight - kHeaderHeight - 10, Font::NumberL, true);
}

void drawContextScreen(TFT_eSprite& s, const tb::DisplayModel& model, uint32_t now) {
  const tb::Link link = model.link(now);
  const tb::FieldView v = model.context(now);
  const bool dim = link == tb::Link::Offline;
  const char* title = model.title(now);
  const bool portrait = width < height;
  const int x = kMargin;
  const int w = portrait ? width - 2 * kMargin : 160 - 2 * kMargin;
  int y = kHeaderHeight + 8;
  drawLabelRow(s, portrait ? "Context window" : "Context", tb::valueTag(v.st, link), x, y, w);
  char buffer[12];
  uint16_t color = kText;
  const char* value = valueText(v, true, buffer, sizeof(buffer), color, dim);
  const bool number = value == buffer;
  y += 20;
  drawText(s, Font::NumberXL, value, x, y, color);
  use(s, Font::NumberXL);
  const int baseline = y + s.gFont.maxAscent;
  if (number) drawText(s, Font::Small, "used", x + textWidth(s, Font::NumberXL, value) + 5, baseline, kMuted, BL_DATUM);
  y = baseline + 8;
  drawBar(s, x, y, w, 8, number ? v.percent : 0, dim ? kFaint : kContext);
  y += 16;
  char line[40];
  if (number) {
    snprintf(line, sizeof(line), "%d%% left", 100 - v.percent);
    drawText(s, Font::Text, line, x, y, kText);
    y += 20;
  }
  tb::formatMeasuredAgo(v.ageSec, line, sizeof(line));
  if (line[0]) {
    drawText(s, Font::Small, line, x, y, kMuted);
    y += 18;
  }
  if (!title) return;
  if (portrait) {
    s.drawFastHLine(kMargin, y, width - 2 * kMargin, kDivider);
    const int available = height - kDotsHeight - (y + 8);
    drawTitle(s, title, kMargin, y + 8, width - 2 * kMargin, static_cast<size_t>(available / 18));
  } else {
    s.drawFastVLine(160, kHeaderHeight + 8, height - kDotsHeight - kHeaderHeight - 16, kDivider);
    const int available = height - kDotsHeight - (kHeaderHeight + 10);
    drawTitle(s, title, 170, kHeaderHeight + 10, width - 170 - kMargin, static_cast<size_t>(available / 18));
  }
}

void drawInfo(TFT_eSprite& s, const tb::DisplayModel& model, uint32_t now, const Frame& frame) {
  const tb::Link link = model.link(now);
  char lastUpdate[24];
  const int64_t since = model.secondsSinceUpdate(now);
  if (since < 0) {
    snprintf(lastUpdate, sizeof(lastUpdate), "none yet");
  } else {
    char duration[16];
    tb::formatDuration(since, duration, sizeof(duration));
    snprintf(lastUpdate, sizeof(lastUpdate), "%s ago", duration);
  }
  const char* usb = frame.hostConnected ? (link == tb::Link::Live ? "Connected" : "Connected, no data") : "Waiting for TokenBeacon";
  const struct {
    const char* label;
    const char* value;
  } rows[] = {
      {"USB", usb},
      {"Last update", lastUpdate},
      {"Firmware", frame.firmware},
      {"Protocol", "device-state/v1"},
      {"Orientation", frame.landscape ? "Landscape" : "Portrait"},
      {"Thread name", model.title(now) ? "Shown" : "Not shown"},
  };
  const int rowCount = sizeof(rows) / sizeof(rows[0]);
  const bool portrait = width < height;
  for (int i = 0; i < rowCount; ++i) {
    const int column = portrait ? 0 : i % 2;
    const int row = portrait ? i : i / 2;
    const int x = kMargin + column * (width / 2);
    const int y = kHeaderHeight + 10 + row * (portrait ? 44 : 40);
    drawText(s, Font::Small, rows[i].label, x, y, kMuted);
    use(s, Font::Text);
    drawWrapped(s, rows[i].value, x, y + 15, (portrait ? width : width / 2) - 2 * kMargin, 1, 18, kText);
  }
}

}  // namespace

void setOrientation(TFT_eSPI& tft, bool landscape) {
  tft.setRotation(landscape ? kLandscapeRotation : kPortraitRotation);
  width = tft.width();
  height = tft.height();
  if (sprite) {
    sprite->unloadFont();
    loadedFont = nullptr;
    sprite->deleteSprite();
    sprite->createSprite(width, height);
    sprite->setTextWrap(false, false);
  }
  tft.fillScreen(kBackground);
}

void begin(TFT_eSPI& tft, bool landscape) {
  tft.setRotation(landscape ? kLandscapeRotation : kPortraitRotation);
  width = tft.width();
  height = tft.height();
  tft.fillScreen(kBackground);
  sprite = new TFT_eSprite(&tft);
  sprite->setColorDepth(16);
  sprite->setAttribute(PSRAM_ENABLE, true);
  sprite->createSprite(width, height);
  sprite->setTextWrap(false, false);
}

void render(TFT_eSPI& tft, const tb::DisplayModel& model, uint32_t nowMs, const Frame& frame) {
  if (!sprite || !sprite->created()) return;
  TFT_eSprite& s = *sprite;
  s.fillSprite(kBackground);
  drawHeader(s, model, nowMs, frame);
  if (!model.hasState() && frame.screen != Screen::Info) {
    drawWaiting(s, frame.hostConnected);
  } else {
    switch (frame.screen) {
      case Screen::Overview: drawOverview(s, model, nowMs); break;
      case Screen::Limits: drawLimits(s, model, nowMs); break;
      case Screen::Context: drawContextScreen(s, model, nowMs); break;
      case Screen::Info: drawInfo(s, model, nowMs, frame); break;
    }
  }
  drawDots(s, frame.screen);
  s.pushSprite(0, 0);
}

}  // namespace ui
