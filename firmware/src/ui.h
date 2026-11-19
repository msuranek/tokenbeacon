// Renders the 170 x 320 portrait screen from the display model.
#pragma once

#include <TFT_eSPI.h>

#include "tb_model.h"

namespace ui {

/** Allocates the frame buffer (PSRAM) and clears the screen. */
void begin(TFT_eSPI& tft);

/** Draws one frame. `firmware` and `connected` are shown in the status line. */
void render(TFT_eSPI& tft, const tb::DisplayModel& model, uint32_t nowMs, bool hostConnected, const char* firmware);

}  // namespace ui
