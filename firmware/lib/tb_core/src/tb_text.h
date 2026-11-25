// UTF-8 helpers for thread titles: validation and line layout by real width.
// Portable and host-tested; the display supplies glyph widths.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace tb {

/** Longest thread title accepted from the host, in UTF-8 bytes (docs/device-protocol.md). */
constexpr size_t kMaxTitleBytes = 200;

/**
 * Decodes the code point starting at s[i]. Returns its length in bytes (1–4),
 * or 0 for an invalid, overlong or truncated sequence or a surrogate.
 */
size_t utf8Decode(const char* s, size_t length, size_t i, uint32_t& codePoint);

/** 1–kMaxTitleBytes bytes of well-formed UTF-8, no control characters, not only spaces. */
bool isTitleText(const char* s, size_t length);

/** Advance width in pixels of a code point as the font will draw it (unsupported glyphs as '?'). */
using AdvanceFn = int (*)(uint32_t codePoint, void* context);

/** Zero-width code points that are never drawn (joiners, variation selectors). */
bool isZeroWidth(uint32_t codePoint);

struct LineSpan {
  uint16_t start = 0;   // byte offset into the text
  uint16_t length = 0;  // bytes, always whole characters
  bool ellipsis = false;  // draw "..." after this line
};

/**
 * Splits `text` into at most `maxLines` lines no wider than `maxWidth`,
 * breaking after spaces where possible and otherwise between characters,
 * never inside a UTF-8 sequence. If the text does not fit, the last line is
 * shortened until it fits together with "..." and is marked `ellipsis`.
 * Leading spaces of continuation lines are skipped. Returns the line count.
 */
size_t layoutText(const char* text, size_t length, int maxWidth, size_t maxLines, AdvanceFn advance, void* context,
                  LineSpan* out);

}  // namespace tb
