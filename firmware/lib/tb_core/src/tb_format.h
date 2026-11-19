// Text and colour levels for the display. Portable and host-tested.
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace tb {

enum class Level : uint8_t { Ok, Warn, Critical };

/** Remaining limit: >= 50 % ok, 20-49 % warn, < 20 % critical. */
Level limitLevel(int percentLeft);
/** Context used: < 60 % ok, 60-79 % warn, >= 80 % critical (as on the web dashboard). */
Level contextLevel(int percentUsed);

/** Compact duration: "45s", "12m", "2h 12m", "3d 8h". Negative -> "". */
void formatDuration(int64_t seconds, char* out, size_t capacity);

}  // namespace tb
