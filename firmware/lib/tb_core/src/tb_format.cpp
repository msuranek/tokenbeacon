#include "tb_format.h"

#include <stdio.h>

namespace tb {

Level limitLevel(int percentLeft) {
  if (percentLeft >= 50) return Level::Ok;
  if (percentLeft >= 20) return Level::Warn;
  return Level::Critical;
}

Level contextLevel(int percentUsed) {
  if (percentUsed >= 80) return Level::Critical;
  if (percentUsed >= 60) return Level::Warn;
  return Level::Ok;
}

void formatDuration(int64_t seconds, char* out, size_t capacity) {
  if (capacity == 0) return;
  if (seconds < 0) {
    out[0] = '\0';
    return;
  }
  const long long s = static_cast<long long>(seconds);
  if (s < 60) snprintf(out, capacity, "%llds", s);
  else if (s < 3600) snprintf(out, capacity, "%lldm", s / 60);
  else if (s < 86400) snprintf(out, capacity, "%lldh %lldm", s / 3600, (s % 3600) / 60);
  else snprintf(out, capacity, "%lldd %lldh", s / 86400, (s % 86400) / 3600);
}

}  // namespace tb
