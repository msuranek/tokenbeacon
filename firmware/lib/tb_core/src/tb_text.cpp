#include "tb_text.h"

namespace tb {

size_t utf8Decode(const char* s, size_t length, size_t i, uint32_t& codePoint) {
  if (i >= length) return 0;
  const uint8_t b0 = static_cast<uint8_t>(s[i]);
  size_t n = 0;
  uint32_t cp = 0;
  uint32_t min = 0;
  if (b0 < 0x80) {
    codePoint = b0;
    return 1;
  } else if ((b0 & 0xE0) == 0xC0) {
    n = 2, cp = b0 & 0x1F, min = 0x80;
  } else if ((b0 & 0xF0) == 0xE0) {
    n = 3, cp = b0 & 0x0F, min = 0x800;
  } else if ((b0 & 0xF8) == 0xF0) {
    n = 4, cp = b0 & 0x07, min = 0x10000;
  } else {
    return 0;
  }
  if (i + n > length) return 0;
  for (size_t k = 1; k < n; ++k) {
    const uint8_t b = static_cast<uint8_t>(s[i + k]);
    if ((b & 0xC0) != 0x80) return 0;
    cp = (cp << 6) | (b & 0x3F);
  }
  if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return 0;
  codePoint = cp;
  return n;
}

bool isTitleText(const char* s, size_t length) {
  if (s == nullptr || length == 0 || length > kMaxTitleBytes) return false;
  bool visible = false;
  for (size_t i = 0; i < length;) {
    uint32_t cp = 0;
    const size_t n = utf8Decode(s, length, i, cp);
    if (n == 0) return false;
    if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F)) return false;
    if (cp != 0x20) visible = true;
    i += n;
  }
  return visible;
}

bool isZeroWidth(uint32_t cp) {
  return cp == 0x200D || cp == 0x200C || (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0x1F3FB && cp <= 0x1F3FF);
}

namespace {

int widthOf(const char* text, size_t from, size_t to, AdvanceFn advance, void* context) {
  int width = 0;
  for (size_t i = from; i < to;) {
    uint32_t cp = 0;
    const size_t n = utf8Decode(text, to, i, cp);
    if (n == 0) break;
    if (!isZeroWidth(cp)) width += advance(cp, context);
    i += n;
  }
  return width;
}

}  // namespace

size_t layoutText(const char* text, size_t length, int maxWidth, size_t maxLines, AdvanceFn advance, void* context,
                  LineSpan* out) {
  if (text == nullptr || maxLines == 0 || maxWidth <= 0) return 0;
  size_t lines = 0;
  size_t pos = 0;
  while (pos < length && lines < maxLines) {
    // Skip leading spaces of a continuation line.
    while (lines > 0 && pos < length && text[pos] == ' ') ++pos;
    if (pos >= length) break;
    size_t end = pos;         // end of what fits
    size_t lastBreak = 0;     // end of the last fitting word (0 = none)
    int width = 0;
    for (size_t i = pos; i < length;) {
      uint32_t cp = 0;
      size_t n = utf8Decode(text, length, i, cp);
      if (n == 0) n = 1, cp = '?';  // never split; treat a broken byte as one character
      const int w = isZeroWidth(cp) ? 0 : advance(cp, context);
      if (width + w > maxWidth && end > pos) break;
      width += w;
      i += n;
      end = i;
      if (cp == ' ') lastBreak = i;
    }
    const bool rest = end < length;
    if (rest && lastBreak > pos && lines + 1 < maxLines) end = lastBreak;  // wrap at a word
    LineSpan& line = out[lines++];
    line.start = static_cast<uint16_t>(pos);
    line.length = static_cast<uint16_t>(end - pos);
    line.ellipsis = false;
    pos = end;
  }
  // Anything left over: shorten the last line until it fits with "...".
  bool remaining = false;
  for (size_t i = pos; i < length; ++i) {
    if (text[i] != ' ') {
      remaining = true;
      break;
    }
  }
  if (remaining && lines > 0) {
    LineSpan& last = out[lines - 1];
    const int dots = 3 * advance('.', context);
    size_t end = last.start + last.length;
    while (end > last.start && widthOf(text, last.start, end, advance, context) + dots > maxWidth) {
      // Step back one whole character.
      size_t prev = end - 1;
      while (prev > last.start && (static_cast<uint8_t>(text[prev]) & 0xC0) == 0x80) --prev;
      end = prev;
    }
    while (end > last.start && text[end - 1] == ' ') --end;
    last.length = static_cast<uint16_t>(end - last.start);
    last.ellipsis = true;
  }
  return lines;
}

}  // namespace tb
